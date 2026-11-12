//! `packages/core/src/project-state.cjs` reconcileState, as Node's ProjectStates `read` applies it to every Project it
//! loads (runtime.cjs): the saved state matched with the Worktrees found now. Node keeps the result in memory and saves
//! it only with a later change; this owner changes nothing, so it applies the same transform to what it answers.
//!
//! Links aren't served, so no Worktree is owned by a shared Chat (`ownedWorktrees` is empty), and Windows path
//! spellings aren't resolved (`nativePath` is the identity off Windows, as here).
use milagre_owner_store::jsjson;
use serde_json::{json, Map, Value};

/// emptyState(projectName).
fn empty_state(project_name: &str) -> Value {
    json!({
        "next_id": 1,
        "projects": {"1": {"id": 1, "name": project_name}},
        "worktrees": {},
        "sessions": {},
        "messages": [],
        "tasks": {},
    })
}

fn values(value: Option<&Value>) -> Vec<&Value> {
    match value {
        Some(Value::Object(map)) => jsjson::js_entries(map)
            .into_iter()
            .map(|(_, item)| item)
            .collect(),
        _ => Vec::new(),
    }
}

/// `{ ...base, ...fields }`: existing keys keep their place, new ones go last.
fn spread(base: &Map<String, Value>, fields: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = base.clone();
    for (key, value) in fields {
        out.insert((*key).to_owned(), value.clone());
    }
    out
}

/// ToNumber for the JSON values a saved id can hold (a missing one is `undefined`: NaN).
fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) if text.trim().is_empty() => 0.0,
        Some(Value::String(text)) => text.trim().parse().unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
}

/// `Math.max(state.next_id ?? 1, ...worktreeIds, ...sessionIds) || 1`.
fn first_free(next_id: Option<&Value>, ids: &[Option<&Value>]) -> f64 {
    let first = match next_id {
        None | Some(Value::Null) => 1.0,
        value => to_number(value),
    };
    let max = ids.iter().map(|id| to_number(*id)).fold(first, |max, id| {
        if max.is_nan() || id.is_nan() {
            f64::NAN
        } else {
            max.max(id)
        }
    });
    if max.is_nan() || max == 0.0 {
        1.0
    } else {
        max
    }
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `Set.has` (SameValueZero) over ids taken from objects.
fn contains(ids: &[Value], value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    ids.iter().any(|id| jsjson::strict_equals(id, value))
}

/// Order-insensitive deep equality of JSON values (util.isDeepStrictEqual for JSON).
fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| deep_equal(value, other)))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| deep_equal(a, b))
        }
        _ => jsjson::strict_equals(a, b) || a == b,
    }
}

/// reconcileState(rawState, projectName, discovered). `state` is `None` for a Project without a saved state.
pub fn reconcile(state: Option<&Value>, project_name: &str, discovered: &[Value]) -> Value {
    let empty = empty_state(project_name);
    let raw = state.filter(|state| state.is_object());
    let state = raw.unwrap_or(&empty);
    let object = state.as_object().cloned().unwrap_or_default();
    let existing_worktrees = values(object.get("worktrees"));
    let existing_sessions = values(object.get("sessions"));
    let ids: Vec<Option<&Value>> = existing_worktrees
        .iter()
        .chain(&existing_sessions)
        .map(|item| item.get("id"))
        .collect();
    let mut next = first_free(object.get("next_id"), &ids);
    let mut allocate = || {
        let id = next;
        next += 1.0;
        number(id)
    };
    // new Map(existing.map(w => [w.path, w])): a later Worktree with the same path wins.
    let by_path = |path: &Value| {
        existing_worktrees
            .iter()
            .rev()
            .find(|worktree| {
                jsjson::strict_equals(worktree.get("path").unwrap_or(&Value::Null), path)
            })
            .copied()
    };
    let mut worktrees = Map::new();
    let mut sessions = Map::new();
    for found in discovered {
        let folder = found.get("path").cloned().unwrap_or(Value::Null);
        let name = found.get("name").cloned().unwrap_or(Value::Null);
        let mut worktree = match by_path(&folder).and_then(Value::as_object) {
            Some(previous) => previous.clone(),
            None => {
                let mut fresh = Map::new();
                fresh.insert("id".into(), allocate());
                fresh.insert("project_id".into(), json!(1));
                fresh.insert("path".into(), folder.clone());
                fresh.insert("name".into(), name.clone());
                fresh
            }
        };
        worktree.shift_remove("sharedChat");
        let id = worktree.get("id").cloned().unwrap_or(Value::Null);
        let worktree = spread(
            &worktree,
            &[
                ("project_id", json!(1)),
                ("path", folder),
                ("name", name.clone()),
            ],
        );
        worktrees.insert(jsjson::property_key(Some(&id)), Value::Object(worktree));
        let mut chats: Vec<Map<String, Value>> = existing_sessions
            .iter()
            .filter(|session| {
                jsjson::strict_equals(session.get("worktree_id").unwrap_or(&Value::Null), &id)
            })
            .filter_map(|session| session.as_object().cloned())
            .collect();
        if chats.is_empty() {
            let mut created = Map::new();
            created.insert("id".into(), allocate());
            created.insert("worktree_id".into(), id.clone());
            created.insert("agent_name".into(), name.clone());
            created.insert("status".into(), json!("Created"));
            chats.push(created);
        }
        for session in chats {
            let agent = if jsjson::truthy(session.get("agent_name")) {
                session["agent_name"].clone()
            } else {
                name.clone()
            };
            let key = jsjson::property_key(session.get("id"));
            let session = spread(
                &session,
                &[("worktree_id", id.clone()), ("agent_name", agent)],
            );
            sessions.insert(key, Value::Object(session));
        }
    }
    let worktree_ids: Vec<Value> = values(Some(&Value::Object(worktrees.clone())))
        .into_iter()
        .map(|worktree| worktree.get("id").cloned().unwrap_or(Value::Null))
        .collect();
    let session_ids: Vec<Value> = values(Some(&Value::Object(sessions.clone())))
        .into_iter()
        .map(|session| session.get("id").cloned().unwrap_or(Value::Null))
        .collect();
    let by_worktree = |field: &str, entry: &Value| contains(&worktree_ids, entry.get(field));
    let filter_map = |value: Option<&Value>, test: &dyn Fn(&Value) -> bool| -> Value {
        let mut out = Map::new();
        if let Some(Value::Object(map)) = value {
            for (key, entry) in jsjson::js_entries(map) {
                if test(entry) {
                    out.insert(key.clone(), entry.clone());
                }
            }
        }
        Value::Object(out)
    };
    let mut fields: Vec<(&str, Value)> = vec![
        ("next_id", number(next)),
        ("projects", json!({"1": {"id": 1, "name": project_name}})),
        ("worktrees", Value::Object(worktrees)),
        ("sessions", Value::Object(sessions)),
    ];
    if jsjson::truthy(object.get("connections")) {
        fields.push((
            "connections",
            filter_map(object.get("connections"), &|connection| {
                by_worktree("left_worktree_id", connection)
                    && by_worktree("right_worktree_id", connection)
            }),
        ));
    }
    if jsjson::truthy(object.get("events")) {
        let events = match object.get("events") {
            Some(Value::Array(events)) => events
                .iter()
                .filter(|event| by_worktree("worktree_id", event))
                .cloned()
                .collect(),
            _ => Vec::new(),
        };
        fields.push(("events", Value::Array(events)));
    }
    let messages = match object.get("messages") {
        Some(Value::Array(messages)) => messages
            .iter()
            .filter(|message| contains(&session_ids, message.get("session_id")))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    fields.push(("messages", Value::Array(messages)));
    fields.push((
        "tasks",
        filter_map(object.get("tasks"), &|task| {
            by_worktree("worktree_id", task)
        }),
    ));
    if jsjson::truthy(object.get("artifacts")) {
        fields.push((
            "artifacts",
            filter_map(object.get("artifacts"), &|artifact| {
                by_worktree("worktree_id", artifact)
            }),
        ));
    }
    let next = Value::Object(spread(&object, &fields));
    match raw {
        Some(raw) if deep_equal(&next, raw) => raw.clone(),
        _ => next,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_state_gains_the_read_fields_and_a_matching_one_is_kept() {
        let saved = json!({
            "next_id": 5,
            "worktrees": {"1": {"id": 1, "path": "/p", "name": "old"}},
            "sessions": {"2": {"id": 2, "worktree_id": 1, "title": "t"}, "3": {"id": 3, "worktree_id": 9}},
            "messages": [{"id": 1, "session_id": 2}, {"id": 2, "session_id": 3}],
        });
        let discovered = [json!({"path": "/p", "name": "p", "plain": true})];
        let read = reconcile(Some(&saved), "p", &discovered);
        assert_eq!(
            read,
            json!({
                "next_id": 5,
                "worktrees": {"1": {"id": 1, "path": "/p", "name": "p", "project_id": 1}},
                "sessions": {"2": {"id": 2, "worktree_id": 1, "title": "t", "agent_name": "p"}},
                "messages": [{"id": 1, "session_id": 2}],
                "projects": {"1": {"id": 1, "name": "p"}},
                "tasks": {},
            })
        );
        let again = reconcile(Some(&read), "p", &discovered);
        assert_eq!(again, read);
        // A Worktree without a Chat gets one, numbered after everything saved.
        let found = [
            json!({"path": "/p", "name": "p"}),
            json!({"path": "/w", "name": "feature"}),
        ];
        let read = reconcile(Some(&read), "p", &found);
        assert_eq!(
            read["worktrees"]["5"],
            json!({"id": 5, "project_id": 1, "path": "/w", "name": "feature"})
        );
        assert_eq!(
            read["sessions"]["6"],
            json!({"id": 6, "worktree_id": 5, "agent_name": "feature", "status": "Created"})
        );
        assert_eq!(read["next_id"], 7);
    }

    #[test]
    fn no_saved_state_is_the_empty_state_reconciled() {
        let read = reconcile(None, "p", &[json!({"path": "/p", "name": "p"})]);
        assert_eq!(read["next_id"], 3);
        assert_eq!(read["worktrees"]["1"]["path"], "/p");
        assert_eq!(read["sessions"]["2"]["status"], "Created");
    }
}

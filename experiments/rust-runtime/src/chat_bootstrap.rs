//! Metadata for the dedicated Project, from Node's project-state reconciliation.
//! Dedicated identity reservations (Worktree 1, starter Chat 1, next_id 10) stay
//! stable. This is not discovery, registry adoption, or a second state writer.
use milagre_owner_store::{
    chat_host::ChatHost, jsjson, message_store::ProjectState, Result, StoreError,
};
use serde_json::{json, Value};
use std::path::Path;

pub(crate) const PROJECT_NAME: &str = "Rust Chat";
const WORKTREE_NAME: &str = "main";

pub(crate) fn seed(project: &str) -> Value {
    json!({
        "next_id":10,"name":PROJECT_NAME,
        "projects":{"1":{"id":1,"name":PROJECT_NAME}},
        "worktrees":{"1":{"id":1,"project_id":1,"name":WORKTREE_NAME,"path":project}},
        "sessions":{"1":{"id":1,"worktree_id":1,"agent_name":WORKTREE_NAME,
            "status":"Created","provider":"claude","permissionMode":"ask"}},
        "messages":[],"tasks":{}
    })
}

/// Fill only absent metadata of the already admitted primary Worktree/its Chats.
/// Existing values (including explicit null/empty values), messages, summaries,
/// timestamps, ids, foreign Worktrees and shared/Link Chats are preserved.
fn missing_metadata(state: &ProjectState, project: &Path) -> Result<Option<ProjectState>> {
    let path = project
        .to_str()
        .ok_or_else(|| StoreError::Invalid("Dedicated Project needs Unicode".into()))?;
    let worktrees = state
        .get("worktrees")
        .and_then(Value::as_object)
        .ok_or_else(|| StoreError::Invalid("Dedicated Project has no Worktrees".into()))?;
    let primary = worktrees
        .get("1")
        .and_then(Value::as_object)
        .filter(|w| {
            jsjson::strict_equals(w.get("id").unwrap_or(&Value::Null), &json!(1))
                && w.get("path").and_then(Value::as_str) == Some(path)
                && !jsjson::truthy(w.get("sharedChat"))
        })
        .ok_or_else(|| StoreError::Invalid("Dedicated primary Worktree changed".into()))?;
    let name = primary.get("name").and_then(Value::as_str).ok_or_else(|| {
        StoreError::Invalid("Dedicated primary Worktree needs its explicit name".into())
    })?;
    let sessions = state
        .sessions()
        .ok_or_else(|| StoreError::Invalid("Dedicated Project has no Chats".into()))?;
    let mut next = state.clone();
    let mut changed = false;
    if !primary.contains_key("project_id") {
        let mut worktrees = worktrees.clone();
        worktrees.get_mut("1").unwrap()["project_id"] = json!(1);
        next = next.with_field("worktrees", Value::Object(worktrees));
        changed = true;
    }
    let mut updated_sessions = sessions.clone();
    let mut sessions_changed = false;
    for session in updated_sessions.values_mut() {
        if let Some(session) = session.as_object_mut() {
            if jsjson::strict_equals(
                session.get("worktree_id").unwrap_or(&Value::Null),
                &json!(1),
            ) && !session.contains_key("agent_name")
                && !jsjson::truthy(session.get("workspacePath"))
                && !jsjson::truthy(session.get("formerWorktree"))
            {
                session.insert("agent_name".into(), json!(name));
                sessions_changed = true;
            }
        }
    }
    if sessions_changed {
        next = next.with_field("sessions", Value::Object(updated_sessions));
        changed = true;
    }
    if state.get("projects").is_none() {
        next = next.with_field("projects", json!({"1":{"id":1,"name":PROJECT_NAME}}));
        changed = true;
    }
    if state.get("tasks").is_none() {
        next = next.with_field("tasks", json!({}));
        changed = true;
    }
    Ok(changed.then_some(next))
}

/// Caller also holds/checks the dedicated DataRoot lease. Use the acquired
/// Project writer after recovery/readiness, before admitting any connection.
pub(crate) fn normalize_owned(host: &mut ChatHost, project: &Path) -> Result<bool> {
    host.require_project_ready(project)?;
    let (_, changed) = host.states.try_update(project, Some(&[]), true, |state| {
        missing_metadata(state, project)
    })?;
    if changed {
        host.states.flush(Some(project))?;
    }
    host.require_project_ready(project)?;
    Ok(changed)
}

#[cfg(test)]
mod tests;

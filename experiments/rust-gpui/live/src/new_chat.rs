//! Milagre's daemon: the new-Chat screen on real data (`NewChatHeading.tsx`, `ChatComposer.tsx` `NewChatHeader` and
//! `App.tsx` `executeSend`), through the same commands Electron's preload sends (`InstalledProject::call`).
//!
//! - The heading's Projects are the loaded ones (no Chats home); the Isolation and branch chips list the Project's
//!   Worktrees from its state, its branches (`project:branches [path]`) and its default base (`project-git:read
//!   [path]`, `effective.baseBranch`); the Linear issue chip shows when Linear is on and connected
//!   (`linear:enabled:read`, `linear:status`) and lists `linear:issues [{}]`. Run on stays hidden until computers land.
//! - A send: in This checkout, `chat:send` with no Chat and the picked Worktree's id; in a new Worktree (or from a
//!   Linear issue, which always gets one), `worktree:create {projectPath, baseBranch, useProjectBase, prompt,
//!   issueKey?, issueWorkspace?}` first, then `chat:send` to the Chat it made for that Worktree. Both on one
//!   request-only connection with the Project loaded ([`Daemon::writer`]), refused in read-only mode.

use milagre_gpui_spike::data::OpenProject;
use milagre_gpui_spike::workspace::chat::composer::new_chat::{
    Isolation, NewChatChoice, NewChatIssue, NewChatOptions, NewChatProject, NewChatWorktree,
};
use serde_json::{Value, json};

use crate::daemon::Daemon;

/// The heading's Projects (loaded, Chats homes left out) and `project`'s Worktrees, from the reducer's state.
pub fn from_state(projects: &[OpenProject], project: Option<&str>) -> NewChatOptions {
    let listed: Vec<NewChatProject> = projects
        .iter()
        .filter(|open| !open.project.is_chats_home())
        .map(|open| NewChatProject { path: open.project.path.clone(), name: open.project.name.clone() })
        .collect();
    let at = project.and_then(|p| listed.iter().find(|o| o.path.as_ref() == p || o.name.as_ref() == p)).or(listed.first());
    let worktrees = at
        .and_then(|at| projects.iter().find(|open| open.project.path == at.path))
        .and_then(|open| open.state.as_ref())
        .map(|state| state.worktrees.values().map(|w| NewChatWorktree { id: w.id, name: w.name.clone(), path: w.path.clone() }).collect())
        .unwrap_or_default();
    NewChatOptions { projects: listed, worktrees, ..NewChatOptions::default() }
}

/// What the daemon reads add to [`from_state`]'s lists: the branches, the Project's base and the Linear issues.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reads {
    pub branches: Vec<String>,
    pub base_branch: Option<String>,
    pub issues: Option<Vec<NewChatIssue>>,
}

impl Reads {
    pub fn apply(&self, options: &mut NewChatOptions) {
        options.branches = self.branches.iter().map(|b| b.clone().into()).collect();
        options.base_branch = self.base_branch.clone().map(Into::into);
        options.issues.clone_from(&self.issues);
    }
}

/// Reads `project`'s branches and base and, when Linear is on and connected, its issues. A read that fails leaves its
/// part empty (the chip then lists nothing, or hides), as the desktop's `.catch(() => {})`.
pub async fn read(daemon: &Daemon, project: &str) -> Reads {
    let branches = daemon.read(project, "project:branches", json!([project])).await.ok();
    let branches = branches
        .as_ref()
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|b| b.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let policy = daemon.read(project, "project-git:read", json!([project])).await.ok();
    let base_branch = policy.as_ref().and_then(|p| p["effective"]["baseBranch"].as_str()).filter(|b| !b.is_empty()).map(str::to_owned);
    let enabled = daemon.read(project, "linear:enabled:read", json!([])).await.ok().is_some_and(|v| v["enabled"] == true);
    let connected = enabled && daemon.read(project, "linear:status", json!([])).await.ok().is_some_and(|v| v["connected"] == true);
    let issues = if connected {
        let listed = daemon.read(project, "linear:issues", json!([{}])).await.ok();
        Some(listed.as_ref().and_then(|v| v["issues"].as_array()).map(|list| list.iter().filter_map(issue).collect()).unwrap_or_default())
    } else {
        None
    };
    Reads { branches, base_branch, issues }
}

fn issue(value: &Value) -> Option<NewChatIssue> {
    let text = |key: &str| value[key].as_str().filter(|s| !s.is_empty()).map(|s| s.to_owned().into());
    Some(NewChatIssue {
        key: text("key")?,
        title: text("title").unwrap_or_default(),
        url: text("url").unwrap_or_default(),
        description: text("description"),
        workspace: text("workspace"),
    })
}

/// A new Chat's `chat:send` fields that do not depend on where it goes.
pub struct Send {
    pub text: String,
    pub client_id: String,
    pub provider: &'static str,
    pub model: String,
    pub mode: &'static str,
    pub effort: Option<String>,
    pub queue: bool,
}

/// The `worktree:create` request a choice needs, if any: a new Worktree, or any Chat started from an issue.
pub fn worktree_request(choice: &NewChatChoice, prompt: &str) -> Option<Value> {
    if choice.isolation == Isolation::Local && choice.issue.is_none() {
        return None;
    }
    let mut request = json!({
        "projectPath": choice.project,
        "baseBranch": choice.base_branch.as_deref().unwrap_or_default(),
        "useProjectBase": !choice.branch_picked,
        "prompt": prompt,
    });
    if let Some(issue) = &choice.issue {
        request["issueKey"] = json!(issue.key);
        if let Some(workspace) = &issue.workspace {
            request["issueWorkspace"] = json!(workspace);
        }
    }
    Some(request)
}

/// The `chat:send` request: to `session` in `worktree` (`None`: the daemon makes the Chat).
pub fn send_request(choice: &NewChatChoice, send: &Send, session: Option<u64>, worktree: u64) -> Value {
    let mut request = json!({
        "projectPath": choice.project,
        "worktreeId": worktree,
        "provider": send.provider,
        "model": send.model,
        "body": send.text,
        "clientMessageId": send.client_id,
        "permissionMode": send.mode,
        "replies": "concise",
        "tldrEnabled": true,
        "ultracode": false,
        "fastMode": false,
    });
    // A Chat the daemon makes names none, as the client's own send.
    if let Some(session) = session {
        request["sessionId"] = json!(session);
    }
    if let Some(effort) = &send.effort {
        request["effort"] = json!(effort);
    }
    if send.queue {
        request["delivery"] = json!("queue");
    }
    if let Some(issue) = &choice.issue {
        let mut linear = json!({"key": issue.key});
        if let Some(workspace) = &issue.workspace {
            linear["workspace"] = json!(workspace);
        }
        request["linearIssue"] = linear;
    }
    request
}

/// The Chat `worktree:create` made for its Worktree (`sessionForWorktree`).
pub fn session_for_worktree(created: &Value) -> Option<(u64, u64)> {
    let worktree = created["worktreeId"].as_u64()?;
    let sessions = created["project"]["state"]["sessions"].as_object()?;
    let session = sessions.values().find(|s| s["worktree_id"].as_u64() == Some(worktree))?;
    Some((session["id"].as_u64()?, worktree))
}

/// Sends the new Chat's first message as Electron does; returns the receipt and the Chat's id.
pub async fn send(daemon: &Daemon, choice: NewChatChoice, send: Send) -> Result<(Value, Option<u64>), String> {
    let project = choice.project.to_string();
    let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
    let mut send = send;
    // No model picked yet: the provider's first recommended one in the daemon's catalog, as an open Chat's send.
    if send.model.is_empty() {
        send.model = writer
            .recommended_model(send.provider)
            .await
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("Milagre recommends no {} model: nothing was sent", send.provider))?;
    }
    let (session, worktree) = match worktree_request(&choice, &send.text) {
        Some(request) => {
            let created =
                writer.call("worktree:create", json!([request])).await.map_err(|e| format!("Couldn't make the Worktree: {e:#}"))?;
            let (session, worktree) = session_for_worktree(&created).ok_or("The new Worktree has no Chat: nothing was sent")?;
            (Some(session), worktree)
        }
        None => (None, choice.worktree.unwrap_or(1)),
    };
    let request = send_request(&choice, &send, session, worktree);
    let receipt = writer.call("chat:send", json!([request])).await.map_err(|e| format!("send {}: {e:#}", send.client_id))?;
    drop(writer);
    let chat = session.or_else(|| receipt["sessionId"].as_u64());
    Ok((receipt, chat))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(isolation: Isolation, issue: bool) -> NewChatChoice {
        NewChatChoice {
            project: "/p".into(),
            isolation,
            worktree: Some(3),
            base_branch: Some("main".into()),
            branch_picked: false,
            issue: issue.then(|| NewChatIssue {
                key: "MIL-1".into(),
                title: "T".into(),
                url: "u".into(),
                description: None,
                workspace: Some("w".into()),
            }),
        }
    }

    #[test]
    fn this_checkout_sends_to_its_worktree_and_a_new_worktree_is_made_first() {
        assert!(worktree_request(&choice(Isolation::Local, false), "hi").is_none());
        let made = worktree_request(&choice(Isolation::Worktree, false), "hi").unwrap();
        assert_eq!(made, json!({"projectPath":"/p","baseBranch":"main","useProjectBase":true,"prompt":"hi"}));
        // An issue always gets its own Worktree, named after it.
        let from_issue = worktree_request(&choice(Isolation::Local, true), "hi").unwrap();
        assert_eq!((from_issue["issueKey"].as_str(), from_issue["issueWorkspace"].as_str()), (Some("MIL-1"), Some("w")));
        let send = Send {
            text: "hi".into(),
            client_id: "c1".into(),
            provider: "claude",
            model: "opus".into(),
            mode: "full",
            effort: Some("high".into()),
            queue: false,
        };
        let request = send_request(&choice(Isolation::Local, true), &send, Some(9), 4);
        assert_eq!((request["sessionId"].as_u64(), request["worktreeId"].as_u64()), (Some(9), Some(4)));
        assert_eq!((request["permissionMode"].as_str(), request["effort"].as_str()), (Some("full"), Some("high")));
        assert_eq!(request["linearIssue"], json!({"key":"MIL-1","workspace":"w"}));
        assert!(send_request(&choice(Isolation::Local, false), &send, None, 3).get("sessionId").is_none());
    }

    #[test]
    fn the_chat_of_a_new_worktree_is_found_by_its_worktree() {
        let created =
            json!({"worktreeId": 5, "project": {"state": {"sessions": {"1": {"id":1,"worktree_id":1}, "8": {"id":8,"worktree_id":5}}}}});
        assert_eq!(session_for_worktree(&created), Some((8, 5)));
        assert_eq!(session_for_worktree(&json!({"worktreeId": 6, "project": {"state": {"sessions": {}}}})), None);
    }
}

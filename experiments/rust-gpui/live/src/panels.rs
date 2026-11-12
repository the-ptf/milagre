//! What the Details tab, the pill row over the composer and the model picker show on Milagre's daemon, built from
//! the live reducer's state (the snapshot plus every released event) and three reads the window makes through the
//! shared client's `InstalledProject::call` (the commands Electron's window sends for the same screens):
//!
//! - `agent:models [projectPath]`: the picker's lists ([`catalog`], `mergeModels`) and the model a Chat with none
//!   recorded shows and sends on (`modelForOpenChat`: picked here, else the last one it ran when the list has it,
//!   else its provider's recommended one).
//! - `agent:ports []`: every Chat's listening ports by Chat key (`AgentPorts`), the Details tab's ports.
//! - `pull-requests:snapshot [projectPath]`: the poll's PRs by Worktree folder and by Chat ref
//!   (`PullRequestSnapshot`), the Details tab's PR and the PR pill (`pullRequestAction`: a blocker's fix).
//!
//! Only what those carry is shown. Not here: a Linear issue's title (only its key is in the state), the Projects a
//! Worktree is linked to, review comments (`pr:detail`), and the Merge pill (it opens the PR panel, not live yet).

use milagre_gpui_spike::data::{Chat, OpenProject, Provider, PullRequest, SubagentStatus};
use milagre_gpui_spike::logic::prs::blockers::{BlockerTone, Checks, PrState, pull_request_action};
use milagre_gpui_spike::workspace::chat::composer::models::{self, ModelOption, Reported};
use milagre_gpui_spike::workspace::chat::pills::data::{self as pills, AgentStatus, PillsData, PortRow, PrAction};
use milagre_gpui_spike::workspace::panel::details::data::{
    AgentInfo, CommandInfo, ComputerInfo, ContextInfo, DetailsData, PrInfo, repo_name,
};
use serde_json::Value;

/// `agent:models` as picker options (`mergeModels`): each provider's own list, recommended first; a provider with an
/// empty or missing list keeps the fixture's ([`models::catalog`] does that merge).
pub fn catalog(reported: &Value) -> Vec<ModelOption> {
    let mut options = Vec::new();
    for provider in [Provider::Codex, Provider::Claude, Provider::Antigravity, Provider::Kiro] {
        let Some(list) = reported[provider.id()].as_array() else { continue };
        for model in list {
            let Some(id) = model["id"].as_str().filter(|id| !id.is_empty()) else { continue };
            let efforts: Vec<String> =
                model["efforts"].as_array().map(|e| e.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
            let flags = Reported {
                recommended: model["recommended"] == true,
                fast_mode: model["fastMode"] == true,
                ultracode: model["ultracode"] == true,
            };
            options.push(models::reported_option(
                provider,
                id,
                model["name"].as_str().unwrap_or(id),
                model["description"].as_str().unwrap_or_default(),
                model["credits"].as_f64(),
                &efforts,
                flags,
            ));
        }
    }
    options
}

/// The model an open Chat shows and its next send names (`modelForOpenChat`): the one picked for it in this window,
/// else the one its last turn ran when the catalog has it for the Chat's provider, else that provider's recommended
/// model, else (no catalog yet) the last one it ran as recorded. Returns the provider, id and the chip's label.
pub fn model_for_chat(provider: Provider, picked: Option<&(Provider, String)>, last: Option<&str>) -> (Provider, String, String) {
    let label = |provider: Provider, id: &str| models::find(provider, id).map_or_else(|| id.to_owned(), |m| m.name.to_owned());
    if let Some((provider, id)) = picked {
        return (*provider, id.clone(), label(*provider, id));
    }
    if let Some(last) = last.filter(|id| models::find(provider, id).is_some()) {
        return (provider, last.to_owned(), label(provider, last));
    }
    if let Some(model) = models::recommended(provider) {
        return (provider, model.id.to_owned(), model.name.to_owned());
    }
    match last {
        Some(last) => (provider, last.to_owned(), label(provider, last)),
        None => (provider, String::new(), provider.name().to_owned()),
    }
}

/// The Chat's PRs (`chatPullRequests`): the ones its summary names, read in its Worktree's folder (or just their
/// numbers until the poll read them), then the Worktree's branch PR when it is not one of them.
pub fn chat_pull_requests(prs: &Value, folder: &str, chat: &Chat) -> Vec<PullRequest> {
    let mut found: Vec<PullRequest> = Vec::new();
    for reference in chat.summary.as_ref().map(|s| s.pull_requests.clone()).unwrap_or_default() {
        match &prs["chats"][folder][reference.as_ref()] {
            Value::Null if prs["chats"][folder].get(reference.as_ref()).is_some() => {}
            Value::Null => {
                if let Some(number) = milagre_gpui_spike::data::pull_request_number(&reference) {
                    found.push(PullRequest { number: Some(number), url: reference.to_string(), ..PullRequest::default() });
                }
            }
            read => found.extend(pull_request(read)),
        }
    }
    if let Some(branch) = pull_request(&prs["worktrees"][folder])
        && !found.iter().any(|pr| pr.number.is_some() && pr.number == branch.number)
    {
        found.push(branch);
    }
    found
}

/// One `PullRequest` of the snapshot; `None` for `null` or a shape without a number.
pub fn pull_request(value: &Value) -> Option<PullRequest> {
    let number = u32::try_from(value["number"].as_u64()?).ok()?;
    Some(PullRequest {
        number: Some(number),
        title: value["title"].as_str().unwrap_or_default().to_owned(),
        url: value["url"].as_str().unwrap_or_default().to_owned(),
        state: match value["state"].as_str() {
            Some("OPEN") => PrState::Open,
            Some("MERGED") => PrState::Merged,
            Some("CLOSED") => PrState::Closed,
            _ => PrState::Other,
        },
        has_conflicts: value["hasConflicts"] == true,
        conflict_status_known: value["conflictStatusKnown"].as_bool(),
        is_behind: value["isBehind"] == true,
        changes_requested: value["changesRequested"] == true,
        checks: match value["checks"].as_str() {
            Some("running") => Some(Checks::Running),
            Some("failed") => Some(Checks::Failed),
            _ => None,
        },
        ready_to_merge: value["readyToMerge"] == true,
        is_draft: value["isDraft"] == true,
    })
}

/// The Chat's ports (`agent:ports`, by Chat key).
pub fn ports_for(ports: &Value, key: &str) -> Vec<PortRow> {
    ports[key]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|port| {
                    Some(PortRow {
                        port: u16::try_from(port["port"].as_u64()?).ok()?,
                        pid: u32::try_from(port["pid"].as_u64()?).ok()?,
                        command: port["command"].as_str().unwrap_or_default().to_owned(),
                        computer: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn status(status: SubagentStatus) -> AgentStatus {
    match status {
        SubagentStatus::Initializing => AgentStatus::Initializing,
        SubagentStatus::Running => AgentStatus::Running,
        SubagentStatus::Waiting => AgentStatus::Waiting,
        SubagentStatus::Completed => AgentStatus::Completed,
        SubagentStatus::Failed => AgentStatus::Failed,
        SubagentStatus::Cancelled => AgentStatus::Cancelled,
        SubagentStatus::Unknown => AgentStatus::Unknown,
    }
}

/// The Chat in `projects` named by `key`, with its Project.
pub fn find<'a>(projects: &'a [OpenProject], key: &str) -> Option<(&'a OpenProject, &'a Chat)> {
    let (path, id) = key.rsplit_once('#')?;
    let id: u64 = id.parse().ok()?;
    let open = projects.iter().find(|open| open.project.path.as_ref() == path)?;
    Some((open, open.state.as_ref()?.chat(id)?))
}

/// The Details tab for `key`: this computer, the repo, the Worktree's branch and folder, the context window, the
/// background commands, ports and subagents, the Linear issue (its key) and the PR (`prs`: the Project's snapshot).
pub fn details(projects: &[OpenProject], key: &str, ports: &Value, prs: &Value, now: i64) -> Option<DetailsData> {
    let (open, chat) = find(projects, key)?;
    let state = open.state.as_ref()?;
    let worktree = state.worktree_of(chat);
    let mut details = DetailsData {
        computer: Some(ComputerInfo { name: "This Mac".into(), state: "Online", offline: false }),
        repo: Some(open.project.origin.as_deref().map_or_else(|| open.project.name.to_string(), repo_name)),
        branch: worktree.map(|w| w.name.to_string()),
        path: worktree.map(|w| w.path.to_string()),
        commands_now: now,
        agents_now: now,
        ..DetailsData::default()
    };
    details.context = chat.context_usage.map(|usage| {
        let summary = milagre_gpui_spike::logic::usage::report::context_summary(usage.used, usage.size);
        ContextInfo {
            used: usage.used,
            size: usage.size,
            percent: summary.percent,
            tokens: summary.tokens,
            claude: chat.provider() == Provider::Claude,
        }
    });
    details.commands = chat
        .background_tasks
        .iter()
        .map(|task| CommandInfo { id: task.id.to_string(), title: task.title.to_string(), started_at: task.started_at })
        .collect();
    details.ports = ports_for(ports, key);
    details.agents = chat
        .subagents
        .iter()
        .filter(|agent| !agent.archived)
        .map(|agent| AgentInfo {
            id: agent.id.to_string(),
            title: agent.title.to_string(),
            status: status(agent.status),
            started_at: agent.started_at,
            ended_at: agent.ended_at,
        })
        .collect();
    let issue = worktree.and_then(|w| w.linear_issue.clone()).or_else(|| chat.summary.as_ref().and_then(|s| s.linear_issue.clone()));
    // The state holds the issue's key only; its title is a `linear:issues` read this window does not make yet.
    details.linear = issue.map(|issue| (issue.to_string(), "Linear issue".to_owned()));
    if let Some(folder) = worktree.map(|w| w.path.to_string()) {
        let list = chat_pull_requests(prs, &folder, chat);
        let first = milagre_gpui_spike::logic::prs::blockers::row_pull_requests(&list).into_iter().next();
        details.pr = first.and_then(|pr| {
            let state = match pr.state {
                PrState::Open if pr.is_draft => "Draft",
                PrState::Open => "Open",
                PrState::Merged => "Merged",
                PrState::Closed => "Closed",
                // A number from the summary the poll has not read yet.
                PrState::Other => "",
            };
            Some(PrInfo { number: pr.number?, state })
        });
    }
    Some(details)
}

/// What the PR pills need besides the state (`App.tsx`): the blockers already sent to the Chat (`dismissed`), whether
/// the PR panel is showing (the review and Merge pills hide then) and the shown PR's open review threads.
#[derive(Clone, Debug, Default)]
pub struct PillInputs {
    pub dismissed: Vec<String>,
    pub pr_shown: bool,
    pub review_comments: u32,
}

/// The PR the panel shows for a Chat (`App.tsx`): one picked (the sidebar's chip), else the first of its row's PRs,
/// else its Worktree's branch PR.
pub fn panel_pull_request(prs: &Value, folder: &str, chat: &Chat, picked: Option<u32>) -> Option<u32> {
    picked.or_else(|| {
        let list = chat_pull_requests(prs, folder, chat);
        milagre_gpui_spike::logic::prs::blockers::row_pull_requests(&list).into_iter().find_map(|pr| pr.number)
    })
}

/// The pill row for `key`: the PR blocker's fix (or Merge #N when the branch PR is ready, `!pr_shown`), the review
/// comments pill, the Chat's plan (Tasks) and its subagents. Ports are in Details.
pub fn pills(projects: &[OpenProject], key: &str, prs: &Value, now: i64, inputs: &PillInputs) -> Option<PillsData> {
    let (open, chat) = find(projects, key)?;
    let folder = open.state.as_ref()?.worktree_of(chat).map(|w| w.path.to_string());
    let list = folder.as_deref().map(|folder| chat_pull_requests(prs, folder, chat)).unwrap_or_default();
    let blocker = pull_request_action(&list, &inputs.dismissed).map(|(_, blocker)| PrAction {
        label: blocker.action_label().into(),
        tone: match blocker.tone() {
            BlockerTone::Orange => milagre_gpui_spike::ui::PillTone::Orange,
            BlockerTone::Red => milagre_gpui_spike::ui::PillTone::Red,
        },
        merge: false,
    });
    // `Merge #N`: no blocker, the branch PR open and ready to merge, the panel not showing.
    let branch = folder.as_deref().and_then(|folder| pull_request(&prs["worktrees"][folder]));
    let merge = branch.filter(|pr| !inputs.pr_shown && pr.state == PrState::Open && pr.ready_to_merge).and_then(|pr| {
        Some(PrAction { label: format!("Merge #{}", pr.number?), tone: milagre_gpui_spike::ui::PillTone::Green, merge: true })
    });
    let pr_action = blocker.or(merge);
    let subagents = chat
        .subagents
        .iter()
        .map(|agent| pills::Subagent {
            id: agent.id.to_string(),
            title: agent.title.to_string(),
            status: status(agent.status),
            started_at: agent.started_at,
            ended_at: agent.ended_at,
            said: agent.latest_activity.as_ref().map(|s| s.to_string()),
            outcome: None,
            result: None,
            tasks: agent
                .tasks
                .iter()
                .map(|task| pills::AgentTask {
                    id: task.id.to_string(),
                    content: task.content.to_string(),
                    active_form: task.active_form.as_ref().map(|s| s.to_string()),
                    status: match task.status {
                        milagre_gpui_spike::data::TaskStatus::Pending => milagre_gpui_spike::logic::plan::TaskStatus::Pending,
                        milagre_gpui_spike::data::TaskStatus::InProgress => milagre_gpui_spike::logic::plan::TaskStatus::InProgress,
                        milagre_gpui_spike::data::TaskStatus::Completed => milagre_gpui_spike::logic::plan::TaskStatus::Completed,
                    },
                })
                .collect(),
            tools: agent.progress.as_ref().map(|p| p.tools).unwrap_or_default(),
            steps: agent.progress.as_ref().map_or(0, |p| p.steps),
            role: agent.agent_type.as_ref().map(|s| s.to_string()),
            model: agent.model.as_ref().map(|id| {
                models::find(agent.provider.unwrap_or(chat.provider()), id).map_or_else(|| id.to_string(), |m| m.name.to_owned())
            }),
            prompt: agent.prompt.as_ref().map(|s| s.to_string()),
            transcript: Vec::new(),
            latest_tool: None,
            archived: agent.archived,
        })
        .collect();
    let review_comments = if inputs.pr_shown { 0 } else { inputs.review_comments };
    Some(PillsData { plan: chat.plan.clone(), ports: Vec::new(), pr_action, review_comments, subagents, now })
}

/// `accounts:list`'s answer as Settings › Accounts' read-only rows: each installed provider's accounts, the one the
/// computer uses marked.
pub fn accounts(list: &Value) -> Vec<milagre_gpui_spike::workspace::preview::PreviewAccount> {
    let mut rows = Vec::new();
    for group in list["providers"].as_array().into_iter().flatten() {
        if group["installed"] == false {
            continue;
        }
        let provider = group["provider"].as_str().unwrap_or_default();
        for account in group["accounts"].as_array().into_iter().flatten() {
            let id = account["id"].as_str().unwrap_or_default();
            let email = account["email"].as_str().filter(|e| !e.is_empty());
            let label = account["label"].as_str().filter(|l| !l.is_empty()).or(email).unwrap_or(id);
            let state = match account["state"].as_str() {
                Some("ready") => None,
                Some("signed-out") => Some("Signed out"),
                Some("signing-in") => Some("Signing in"),
                Some("error") => Some("Needs attention"),
                _ => Some("Not checked"),
            };
            let detail = [email.filter(|e| *e != label), account["plan"].as_str().filter(|p| !p.is_empty()), state]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" \u{b7} ");
            rows.push(milagre_gpui_spike::workspace::preview::PreviewAccount {
                provider: provider.to_owned().into(),
                label: label.to_owned().into(),
                detail: detail.into(),
                selected: group["selectedId"].as_str() == Some(id),
                id: id.to_owned().into(),
                ready: account["state"] == "ready",
            });
        }
    }
    rows
}

//! What the Details tab shows for one Chat, built from the data source (`DataSource`: the Chat's scope state, its
//! Project, the computers) and the pills' fixture (ports and subagents, which the host will send with the Chat).
//! Panel-local like `panel/fixture.rs`: this is the one seam a daemon-backed source replaces.

use std::sync::Arc;

use super::fixture;
use crate::data::{self, ChatId, ComputerState, DataSource, LOCAL, Millis, ScopeKey, SubagentStatus};
use crate::logic::marks::display_clock::format_elapsed;
use crate::logic::usage::report::context_summary;
use crate::workspace::chat::pills::data::{self as pills, AgentStatus, PortRow};
use crate::workspace::panel::pr::fixture::Variant;

/// The computer the Chat's Project lives on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerInfo {
    /// "This Mac", or the paired computer's name.
    pub name: String,
    /// "Online", "Offline", ...
    pub state: &'static str,
    /// Drawn in `orange-ink`.
    pub offline: bool,
}

/// The Chat's context window, as the composer's ring reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextInfo {
    pub used: f64,
    pub size: f64,
    pub percent: i64,
    /// "120k of 200k tokens".
    pub tokens: String,
    /// Compact is a Claude command.
    pub claude: bool,
}

/// A background command the agent runs (`BackgroundTask`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandInfo {
    pub id: String,
    pub title: String,
    pub started_at: Millis,
}

/// A subagent, running or finished.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentInfo {
    pub id: String,
    pub title: String,
    pub status: AgentStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// The Chat's PR: its number and how it stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrInfo {
    pub number: u32,
    pub state: &'static str,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DetailsData {
    pub computer: Option<ComputerInfo>,
    /// "owner/repo" from the Project's origin, else the Project's name.
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub path: Option<String>,
    pub context: Option<ContextInfo>,
    pub commands: Vec<CommandInfo>,
    pub ports: Vec<PortRow>,
    pub agents: Vec<AgentInfo>,
    /// The fixture clock the commands' times count from (`data::fixture::NOW`).
    pub commands_now: Millis,
    /// The fixture clock the subagents' times count from (the pills').
    pub agents_now: i64,
    pub linear: Option<(String, String)>,
    pub pr: Option<PrInfo>,
    /// Other Projects this Chat's Worktree is linked to.
    pub links: Vec<String>,
}

/// "github.com/owner/repo" is "owner/repo"; a bare name stays.
pub fn repo_name(origin: &str) -> String {
    let parts: Vec<&str> = origin.trim_end_matches(".git").split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [.., owner, repo] => format!("{owner}/{repo}"),
        [one] => (*one).to_owned(),
        [] => String::new(),
    }
}

/// Keeps the start and the end of `text` and puts an ellipsis between them when it is longer than `max` characters,
/// the way the reference shows a long branch ("milagre/fix-lin…ro-hang").
pub fn middle_truncate(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max || max < 3 {
        return text.to_owned();
    }
    let keep = max - 1;
    let tail = keep / 2;
    let head = keep - tail;
    let start: String = chars[..head].iter().collect();
    let end: String = chars[chars.len() - tail..].iter().collect();
    format!("{start}\u{2026}{end}")
}

/// The word for a computer's state (`ComputerState`).
pub fn state_label(state: ComputerState) -> &'static str {
    match state {
        ComputerState::Off => "Off",
        ComputerState::Connecting => "Connecting",
        ComputerState::Online => "Online",
        ComputerState::Reconnecting => "Reconnecting",
        ComputerState::Offline => "Offline",
        ComputerState::Refused => "Refused",
    }
}

fn pr_state(number: u32) -> &'static str {
    match Variant::for_number(number) {
        Variant::Draft => "Draft",
        Variant::Merged => "Merged",
        Variant::Closed => "Closed",
        Variant::Ready | Variant::Pending | Variant::Blocked => "Open",
    }
}

/// How long a task has run (or ran): "6m 12s".
pub fn elapsed(started_at: i64, ended_at: Option<i64>, now: i64) -> String {
    format_elapsed((ended_at.unwrap_or(now) - started_at) as f64)
}

impl DetailsData {
    /// Details for the Chat `key` (`<scope>#<id>`). `pr` is the number the panel's PR tab shows; `seeded` marks the
    /// Chat open at startup, which the fixture gives everything.
    pub fn load(key: &str, pr: Option<u32>, seeded: bool, source: Option<&Arc<dyn DataSource>>) -> DetailsData {
        let mut details = DetailsData { pr: pr.map(|number| PrInfo { number, state: pr_state(number) }), ..DetailsData::default() };
        let Some(source) = source else { return details };
        let Some((scope, id)) = key.rsplit_once('#') else { return details };
        let (scope, Ok(id)) = (ScopeKey(scope.to_owned().into()), id.parse::<ChatId>()) else { return details };
        let computers = data::now(source.computers()).unwrap_or_default();
        let computer = scope.computer();
        let project = data::now(source.recent_projects(computer.to_owned().into()))
            .ok()
            .and_then(|projects| projects.into_iter().find(|project| project.scope() == scope));
        details.computer = Some(if computer == LOCAL {
            ComputerInfo { name: "This Mac".into(), state: "Online", offline: false }
        } else {
            let found = computers.computers.iter().find(|candidate| candidate.id.as_ref() == computer);
            let state = found.map_or(ComputerState::Offline, |found| found.state);
            ComputerInfo { name: computers.name_of(computer).to_string(), state: state_label(state), offline: state.is_dimmed() }
        });
        details.repo = project.as_ref().map(|project| project.origin.as_deref().map_or_else(|| project.name.to_string(), repo_name));
        let Ok(read) = data::now(source.read_state(scope)) else { return details };
        let Some(chat) = read.state.chat(id) else { return details };
        if let Some(worktree) = read.state.worktree_of(chat) {
            details.branch = Some(worktree.name.to_string());
            details.path = Some(worktree.path.to_string());
            details.linear = worktree.linear_issue.clone().map(|issue| (issue.to_string(), fixture::issue_title(&issue)));
        }
        let usage = chat.context_usage;
        details.context = usage.map(|usage| ContextInfo {
            used: usage.used,
            size: usage.size,
            percent: context_summary(usage.used, usage.size).percent,
            tokens: context_summary(usage.used, usage.size).tokens,
            claude: chat.provider() == data::Provider::Claude,
        });
        details.commands_now = data::fixture::NOW;
        details.commands = chat
            .background_tasks
            .iter()
            .map(|task| CommandInfo { id: task.id.to_string(), title: task.title.to_string(), started_at: task.started_at })
            .collect();
        // Subagents the agent launched in the background count as running work too; the pills' fixture carries the
        // ports and the subagents' details.
        let title = chat.summary.as_ref().and_then(|summary| summary.title_line.clone()).unwrap_or_else(|| chat.agent_name.clone());
        let pills = pills::pills_for(key, &title);
        details.ports = pills.ports;
        details.agents_now = pills.now;
        details.agents = pills
            .subagents
            .iter()
            .filter(|agent| !agent.archived)
            .map(|agent| AgentInfo {
                id: agent.id.clone(),
                title: agent.title.clone(),
                status: agent.status,
                started_at: agent.started_at,
                ended_at: agent.ended_at,
            })
            .collect();
        let _ = SubagentStatus::Running;
        fixture::add_extras(&mut details, key, seeded);
        details
    }

    pub fn running_agents(&self) -> impl Iterator<Item = &AgentInfo> {
        self.agents.iter().filter(|agent| agent.status.active())
    }

    pub fn finished_agents(&self) -> impl Iterator<Item = &AgentInfo> {
        self.agents.iter().filter(|agent| agent.status.finished())
    }

    pub fn finished_count(&self) -> usize {
        self.finished_agents().count()
    }

    pub fn running_count(&self) -> usize {
        self.commands.len() + self.ports.len() + self.running_agents().count()
    }

    pub fn has_links_section(&self) -> bool {
        self.linear.is_some() || self.pr.is_some() || !self.links.is_empty()
    }
}

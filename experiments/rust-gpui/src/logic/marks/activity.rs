//! What a Chat is doing, in one word, for every surface that shows or announces it (`packages/shared/src/chat-activity.mjs`):
//! sidebar rows, the Chat's status line, the inbox, linked and MCP Chat status, and notifications. A turn's end is
//! not the end of the Chat's work: background work outlives it (a provider's background subagents and tasks, and
//! Milagre's advisors), and the Chat stays "background" until the last of it ends.
//!
//! Provider capabilities come from `logic::identity::capabilities`; `agent-runs.mjs`'s `isTurnEnd` and
//! `subagentActive` are the small helpers here ([`AgentEvent::is_turn_end`], [`subagent_active`]).

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::Hash;

use crate::logic::identity::capabilities::provider_capabilities;

/// What a Chat is doing: the word `activityOf` returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    /// The turn waits on the user (an approval or a question).
    Waiting,
    /// A turn runs.
    Working,
    /// The last turn failed.
    Failed,
    /// No turn runs, but background work goes on and its results come back to the Chat.
    Background,
    /// Nothing runs.
    Idle,
}

impl Activity {
    /// The word the TypeScript uses.
    pub fn key(self) -> &'static str {
        match self {
            Activity::Waiting => "waiting",
            Activity::Working => "working",
            Activity::Failed => "failed",
            Activity::Background => "background",
            Activity::Idle => "idle",
        }
    }
}

/// What `activityOf` reads. All default to off.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ActivityInput {
    pub running: bool,
    pub waiting: bool,
    pub failed: bool,
    /// How much background work still goes on.
    pub background: usize,
}

/// The activity from what is known of a Chat. The first that applies wins:
/// - waiting: the turn waits on the user (an approval or a question);
/// - working: a turn runs;
/// - failed: the last turn failed. It wins over background work, so a failure is never shown as work still going;
/// - background: no turn runs, but background work goes on and its results come back to the Chat;
/// - idle: nothing runs.
pub fn activity_of(input: ActivityInput) -> Activity {
    if input.running && input.waiting {
        Activity::Waiting
    } else if input.running {
        Activity::Working
    } else if input.failed {
        Activity::Failed
    } else if input.background > 0 {
        Activity::Background
    } else {
        Activity::Idle
    }
}

/// Whether the Chat's work is still under way: a turn runs, or background work goes on.
pub fn activity_busy(activity: Activity) -> bool {
    matches!(activity, Activity::Working | Activity::Waiting | Activity::Background)
}

/// A subagent (`Subagent`), trimmed to what the activity reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Subagent {
    pub id: String,
    pub title: String,
    /// `initializing`, `running`, `waiting`, `completed`, ...
    pub status: Option<String>,
    /// Whether its work outlives the turn that started it.
    pub background: bool,
    /// `milagre-advisor` for an advisor.
    pub source: Option<String>,
    pub started_at: Option<f64>,
}

/// A background task a provider's agent process reports (`backgroundTasks`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BackgroundTask {
    pub id: String,
    /// `local_bash` (a command), `local_workflow`, `mcp_task`, ...
    pub kind: String,
    pub title: String,
    pub started_at: Option<f64>,
}

/// Whether a subagent is still at work: not ended yet, or waiting on an approval.
pub fn subagent_active(agent: &Subagent) -> bool {
    matches!(agent.status.as_deref(), Some("initializing" | "running" | "waiting"))
}

const ADVISOR_SOURCE: &str = "milagre-advisor";

/// What the activity rules read from a saved Chat (`AgentSession`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ActivitySession {
    /// The Chat's provider; a Chat saved before providers were recorded runs on Claude.
    pub provider: Option<String>,
    /// The provider's own session id: a subagent with it is the parent itself, not a child.
    pub native_session_id: Option<String>,
    pub subagents: Vec<Subagent>,
    pub background_tasks: Vec<BackgroundTask>,
    /// `summary.lastOutcome`, as `completed`, `failed` or `cancelled`.
    pub last_outcome: Option<String>,
}

/// A Chat's streaming run (`agent-runs.mjs`): whether it waits on the user.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RunState {
    pub approvals: usize,
    pub questions: usize,
}

/// Work the Chat's agent process holds: a background subagent or a task.
#[derive(Clone, Debug, PartialEq)]
pub enum Work {
    Subagent(Subagent),
    Task(BackgroundTask),
}

impl Work {
    pub fn id(&self) -> &str {
        match self {
            Work::Subagent(agent) => &agent.id,
            Work::Task(task) => &task.id,
        }
    }

    pub fn started_at(&self) -> Option<f64> {
        match self {
            Work::Subagent(agent) => agent.started_at,
            Work::Task(task) => task.started_at,
        }
    }
}

// `Array.prototype.sort` is stable, so is this; a missing start counts as 0.
fn oldest_first<T>(items: &mut [T], started_at: impl Fn(&T) -> Option<f64>) {
    items.sort_by(|a, b| started_at(a).unwrap_or(0.0).partial_cmp(&started_at(b).unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
}

fn owns_background(session: &ActivitySession) -> bool {
    provider_capabilities(Some(session.provider.as_deref().unwrap_or("claude"))).background_subagents
}

/// The Chat's background subagents still at work, oldest first; none for a provider without them.
pub fn background_subagents(session: &ActivitySession) -> Vec<Subagent> {
    if !owns_background(session) {
        return Vec::new();
    }
    let mut agents: Vec<Subagent> = session
        .subagents
        .iter()
        .filter(|agent| agent.background && subagent_active(agent) && session.native_session_id.as_deref() != Some(agent.id.as_str()))
        .cloned()
        .collect();
    oldest_first(&mut agents, |agent| agent.started_at);
    agents
}

/// The Chat's other background tasks (a command run in the background, an MCP task, a workflow), oldest first.
pub fn background_tasks(session: &ActivitySession) -> Vec<BackgroundTask> {
    if !owns_background(session) {
        return Vec::new();
    }
    let mut tasks = session.background_tasks.clone();
    oldest_first(&mut tasks, |task| task.started_at);
    tasks
}

/// The background work the Chat's agent process holds: its background subagents and tasks. Anything that ends that
/// process (a handoff to another provider, a reload, a move to another folder) would stop it.
pub fn process_work(session: &ActivitySession) -> Vec<Work> {
    let mut work: Vec<Work> = background_subagents(session).into_iter().map(Work::Subagent).collect();
    work.extend(background_tasks(session).into_iter().map(Work::Task));
    oldest_first(&mut work, Work::started_at);
    work
}

/// Whether a subagent's work outlives the turn and comes back to the Chat by itself: a provider's background
/// subagent, or a Milagre advisor (its result reaches the Chat as a message of its own).
pub fn outlives_turn(agent: &Subagent) -> bool {
    agent.background || agent.source.as_deref() == Some(ADVISOR_SOURCE)
}

fn active_advisors(session: &ActivitySession) -> Vec<Subagent> {
    session.subagents.iter().filter(|agent| agent.source.as_deref() == Some(ADVISOR_SOURCE) && subagent_active(agent)).cloned().collect()
}

/// Everything still at work for the Chat with no turn of its own, oldest first: its process's work and its advisors.
pub fn background_work(session: &ActivitySession) -> Vec<Work> {
    let mut work = process_work(session);
    work.extend(active_advisors(session).into_iter().map(Work::Subagent));
    oldest_first(&mut work, Work::started_at);
    work
}

/// What kind of background work a line of the background list is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackgroundKind {
    Subagent,
    Advisor,
    Command,
    Workflow,
    Task,
}

impl BackgroundKind {
    /// `BACKGROUND_ITEM_LABELS`.
    pub fn label(self) -> &'static str {
        match self {
            BackgroundKind::Subagent => "Subagent",
            BackgroundKind::Advisor => "Advisor",
            BackgroundKind::Command => "Command",
            BackgroundKind::Workflow => "Workflow",
            BackgroundKind::Task => "Task",
        }
    }
}

/// One line of the Chat's background list.
#[derive(Clone, Debug, PartialEq)]
pub struct BackgroundItem {
    pub kind: BackgroundKind,
    pub id: String,
    pub title: String,
    pub started_at: Option<f64>,
    /// The subagent or advisor itself, for its transcript; a task has none.
    pub agent: Option<Subagent>,
}

/// A port a Chat's command listens on (`ports`): the command's task, when it was started in the background.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatPort {
    pub task_id: Option<String>,
}

/// The Chat's background work as its background line lists it, oldest first: what each is and since when. A
/// command serving one of the Chat's ports shows in Ports, where it can be opened and stopped, and not here too.
pub fn background_items(session: &ActivitySession, ports: &[ChatPort]) -> Vec<BackgroundItem> {
    let served: HashSet<&str> = ports.iter().filter_map(|port| port.task_id.as_deref()).filter(|id| !id.is_empty()).collect();
    let agent_item = |kind| {
        move |agent: Subagent| BackgroundItem {
            kind,
            id: agent.id.clone(),
            title: agent.title.clone(),
            started_at: agent.started_at,
            agent: Some(agent),
        }
    };
    let mut items: Vec<BackgroundItem> = background_subagents(session).into_iter().map(agent_item(BackgroundKind::Subagent)).collect();
    items.extend(active_advisors(session).into_iter().map(agent_item(BackgroundKind::Advisor)));
    items.extend(background_tasks(session).into_iter().filter(|task| !served.contains(task.id.as_str())).map(|task| BackgroundItem {
        kind: match task.kind.as_str() {
            "local_bash" => BackgroundKind::Command,
            "local_workflow" => BackgroundKind::Workflow,
            _ => BackgroundKind::Task,
        },
        id: task.id,
        title: task.title,
        started_at: task.started_at,
        agent: None,
    }));
    oldest_first(&mut items, |item| item.started_at);
    items
}

/// A Chat's activity, with how much background work still goes on and since when.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChatActivity {
    pub activity: Activity,
    pub background: usize,
    /// When the oldest background work began; `None` with no work (or work with no start).
    pub since: Option<f64>,
}

/// A Chat's activity from its saved session and its streaming run, with how much background work still goes on and
/// since when. `last_outcome` is how its last reply ended, for a session without a summary; `None` reads the
/// session's own.
pub fn chat_activity(session: &ActivitySession, run: Option<RunState>, last_outcome: Option<&str>) -> ChatActivity {
    let work = background_work(session);
    let last_outcome = last_outcome.or(session.last_outcome.as_deref());
    let activity = activity_of(ActivityInput {
        running: run.is_some(),
        waiting: run.is_some_and(|run| run.approvals > 0 || run.questions > 0),
        failed: last_outcome == Some("failed"),
        background: work.len(),
    });
    ChatActivity { activity, background: work.len(), since: work.first().and_then(Work::started_at) }
}

/// A background command's output (`chat:task-output`) as plain text: without escape sequences, and a line the
/// command redrew with carriage returns (a progress bar) as it stands now.
pub fn plain_task_output(text: Option<&str>) -> String {
    let stripped = strip_escapes(text.unwrap_or(""));
    stripped.split('\n').map(|line| line.trim_end_matches('\r').rsplit('\r').next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

/// Removes what the `ESCAPES` expression matches: CSI (`ESC [ params intermediates final`), OSC (`ESC ] ... BEL` or
/// `ESC ] ... ESC \`) and two-character escapes (`ESC intermediates final`), trying them in that order.
fn strip_escapes(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == '\u{1b}'
            && let Some(len) = escape_len(&chars[at..])
        {
            at += len;
            continue;
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// The length of the escape sequence at the start of `s` (which starts with ESC), if one matches.
fn escape_len(s: &[char]) -> Option<usize> {
    let run = |from: usize, low: char, high: char| s[from..].iter().take_while(|c| (low..=high).contains(*c)).count();
    // CSI: ESC [ [0-?]* [ -/]* [@-~]
    if s.get(1) == Some(&'[') {
        let params = run(2, '0', '?');
        let intermediates = run(2 + params, ' ', '/');
        let end = 2 + params + intermediates;
        if s.get(end).is_some_and(|c| ('@'..='~').contains(c)) {
            return Some(end + 1);
        }
    }
    // OSC: ESC ] [^BEL ESC]* (BEL | ESC \)
    if s.get(1) == Some(&']') {
        let body = s[2..].iter().take_while(|c| **c != '\u{7}' && **c != '\u{1b}').count();
        match (s.get(2 + body), s.get(3 + body)) {
            (Some('\u{7}'), _) => return Some(body + 3),
            (Some('\u{1b}'), Some('\\')) => return Some(body + 4),
            _ => {}
        }
    }
    // ESC [ -/]* [@-~]
    let intermediates = run(1, ' ', '/');
    if s.get(1 + intermediates).is_some_and(|c| ('@'..='~').contains(c)) {
        return Some(intermediates + 2);
    }
    None
}

/// "1 background task", "3 background tasks": agents, commands and advisors alike.
pub fn background_label(count: usize) -> String {
    format!("{count} background task{}", if count == 1 { "" } else { "s" })
}

/// The action a background guard refuses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackgroundAction {
    /// Hand the Chat to another provider.
    Switch,
    /// Reload its agent.
    Reload,
    /// Start its agent in another folder.
    Move,
}

/// Why Milagre won't do what would stop the background work a Chat's agent process holds: hand the Chat to another
/// provider ("switch", naming it as `to`), reload its agent ("reload"), or start its agent in another folder
/// ("move"). Each ends that process, and the work with it, so the Chat waits for the work instead.
pub fn background_busy_message(action: BackgroundAction, count: usize, to: &str) -> String {
    let one = count == 1;
    let running = if one {
        "A background task is still running in this Chat".to_owned()
    } else {
        format!("{count} background tasks are still running in this Chat")
    };
    let it = if one { "it" } else { "them" };
    let ends = if one { "it finishes" } else { "they finish" };
    match action {
        BackgroundAction::Reload => format!("{running}. Reloading would stop {it}. Ask the agent to stop {it}, or reload once {ends}."),
        BackgroundAction::Switch => {
            format!("{running}. Switching to {to} would stop {it}. Ask the agent to stop {it}, or send again once {ends}.")
        }
        BackgroundAction::Move => {
            format!(
                "{running}, and its agent can't move to another folder without stopping {it}. Ask the agent to stop {it}, or send again once {ends}."
            )
        }
    }
}

/// The `to` of [`background_busy_message`] when the caller names none.
pub const ANOTHER_AGENT: &str = "another agent";

/// Keep the beginning of the latest reply; ordinary paragraph breaks stay in the preview. At most 4096 UTF-16 code
/// units (a cut never splits a surrogate pair).
pub fn notification_preview(previous: Option<&str>, text: Option<&str>, starts_message: bool) -> String {
    let joined = format!("{}{}", if starts_message { "" } else { previous.unwrap_or("") }, text.unwrap_or(""));
    crate::logic::lists::jsstr::utf16_prefix(&joined, 4096).to_owned()
}

/// Whether a background task holds back the announcement of the turn that started it. A command run in the
/// background doesn't: it can be a server that never ends, and the turn's end would never be announced.
pub fn holds_announcement(task: &BackgroundTask) -> bool {
    task.kind != "local_bash"
}

/// How a turn ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnEnd {
    Completed,
    Cancelled,
    Failed,
}

/// An agent event, trimmed to what the activity tracker reads (`AgentEvent`).
#[derive(Clone, Debug, PartialEq)]
pub enum AgentEvent {
    TurnStarted,
    MessageSent,
    AnswersSent,
    TextDelta {
        text: Option<String>,
        starts_message: bool,
    },
    PermissionRequest {
        request_id: Option<String>,
    },
    QuestionRequest {
        request_id: Option<String>,
    },
    PermissionResolved {
        request_id: Option<String>,
    },
    QuestionResolved {
        request_id: Option<String>,
    },
    SubagentUpdate(Subagent),
    BackgroundTasks(Vec<BackgroundTask>),
    /// `turn-completed`, `turn-cancelled` or `turn-failed`. `quiet`: a heartbeat's "(pass)", or a turn failing
    /// again, which announces nothing. `message` is a failure's text.
    TurnEnded {
        end: TurnEnd,
        message: Option<String>,
        quiet: bool,
    },
    /// Any other event: nothing to follow.
    Other,
}

impl AgentEvent {
    /// Whether the event ends a turn (`isTurnEnd`).
    pub fn is_turn_end(&self) -> bool {
        matches!(self, AgentEvent::TurnEnded { .. })
    }
}

/// The end of a turn the tracker announces.
#[derive(Clone, Debug, PartialEq)]
pub struct Announcement {
    pub failed: bool,
    /// The failure's message, or the reply's start ("Turn completed." when there was none).
    pub body: Option<String>,
    /// The event that ended the turn.
    pub event: AgentEvent,
}

/// What [`ActivityTracker::observe`] says an event changed.
#[derive(Clone, Debug, PartialEq)]
pub struct Observed {
    pub previous: Activity,
    pub next: Activity,
    /// Set when the Chat's work just ended: it left working or background for idle or failed, after a turn that
    /// completed or failed.
    pub completion: Option<Announcement>,
}

/// The most Chats a tracker follows before it forgets the oldest.
pub const DEFAULT_MAX_CHATS: usize = 500;

#[derive(Clone, Debug, Default)]
struct Tracked {
    running: bool,
    ended: bool,
    requests: HashSet<String>,
    agents: HashSet<String>,
    tasks: HashSet<String>,
    failed: bool,
    preview: String,
    end: Option<Announcement>,
}

impl Tracked {
    fn background(&self) -> usize {
        self.agents.len() + self.tasks.len()
    }

    fn activity(&self) -> Activity {
        activity_of(ActivityInput {
            running: self.running,
            waiting: !self.requests.is_empty(),
            failed: self.failed,
            background: self.background(),
        })
    }
}

/// Follows Chats from their agent events alone, for the notifiers that see no saved state (desktop's main process
/// and the daemon's phone push). `observe` folds an event and says how the Chat's activity changed; `completion` is
/// set when the Chat's work just ended: it left working or background for idle or failed, after a turn that
/// completed or failed. A turn that ends while background work goes on announces nothing then; the turn its result
/// wakes announces its own end, and if none comes the held end is announced when the last of it ends. A cancelled or
/// quiet turn announces nothing. Only work that holds the announcement counts here ([`holds_announcement`]); the
/// Chat's sidebar row shows all of it.
pub struct ActivityTracker<K: Clone + Eq + Hash> {
    max_chats: usize,
    holds_task: Box<dyn Fn(&BackgroundTask) -> bool>,
    chats: HashMap<K, Tracked>,
    /// Insertion order, oldest first, for the cap.
    order: VecDeque<K>,
}

impl<K: Clone + Eq + Hash> Default for ActivityTracker<K> {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CHATS)
    }
}

impl<K: Clone + Eq + Hash> ActivityTracker<K> {
    pub fn new(max_chats: usize) -> Self {
        Self::with_holds_task(max_chats, holds_announcement)
    }

    /// A tracker with its own rule for which background tasks hold an announcement.
    pub fn with_holds_task(max_chats: usize, holds_task: impl Fn(&BackgroundTask) -> bool + 'static) -> Self {
        Self { max_chats, holds_task: Box::new(holds_task), chats: HashMap::new(), order: VecDeque::new() }
    }

    pub fn observe(&mut self, chat_id: &K, event: &AgentEvent) -> Observed {
        let mut chat = match self.chats.remove(chat_id) {
            Some(chat) => chat,
            None => {
                self.order.push_back(chat_id.clone());
                Tracked::default()
            }
        };
        // A turn's end means a turn ran, even one that started before this tracker was listening.
        if event.is_turn_end() && !chat.running && !chat.ended {
            chat.running = true;
        }
        let previous = chat.activity();
        match event {
            AgentEvent::TurnStarted => {
                chat.running = true;
                chat.ended = false;
                chat.failed = false;
                chat.end = None;
                chat.preview.clear();
            }
            AgentEvent::MessageSent => {
                chat.preview.clear();
                chat.running = true;
                chat.ended = false;
                chat.failed = false;
                chat.end = None;
            }
            AgentEvent::AnswersSent => chat.preview.clear(),
            AgentEvent::TextDelta { text, starts_message } => {
                if chat.running {
                    chat.preview = notification_preview(Some(&chat.preview), text.as_deref(), *starts_message);
                }
            }
            AgentEvent::PermissionRequest { request_id } | AgentEvent::QuestionRequest { request_id } => {
                if let (true, Some(id)) = (chat.running, request_id) {
                    chat.requests.insert(id.clone());
                }
            }
            AgentEvent::PermissionResolved { request_id } | AgentEvent::QuestionResolved { request_id } => {
                if let Some(id) = request_id {
                    chat.requests.remove(id);
                }
            }
            AgentEvent::SubagentUpdate(agent) => {
                if outlives_turn(agent) {
                    if subagent_active(agent) {
                        chat.agents.insert(agent.id.clone());
                    } else {
                        chat.agents.remove(&agent.id);
                    }
                }
            }
            AgentEvent::BackgroundTasks(tasks) => {
                chat.tasks = tasks.iter().filter(|task| (self.holds_task)(task)).map(|task| task.id.clone()).collect();
            }
            AgentEvent::TurnEnded { end, message, quiet } => {
                chat.running = false;
                chat.ended = true;
                chat.requests.clear();
                chat.failed = *end == TurnEnd::Failed;
                // A quiet turn (a heartbeat's "(pass)", or one failing again) has nothing to announce, like a
                // cancelled one.
                chat.end = if *end == TurnEnd::Cancelled || *quiet {
                    None
                } else {
                    let body = if chat.failed {
                        message.clone()
                    } else if chat.preview.is_empty() {
                        Some("Turn completed.".to_owned())
                    } else {
                        Some(chat.preview.clone())
                    };
                    Some(Announcement { failed: chat.failed, body, event: event.clone() })
                };
                chat.preview.clear();
            }
            AgentEvent::Other => {}
        }
        let next = chat.activity();
        let mut completion = None;
        if previous != next && activity_busy(previous) && matches!(next, Activity::Idle | Activity::Failed) {
            completion = chat.end.take();
        }
        // The cap: the oldest followed Chat goes, which can be this one when the cap is 0.
        let evicted = if self.order.len() > self.max_chats { self.order.pop_front() } else { None };
        if evicted.as_ref() != Some(chat_id) {
            self.chats.insert(chat_id.clone(), chat);
        }
        if let Some(evicted) = evicted {
            self.chats.remove(&evicted);
        }
        Observed { previous, next, completion }
    }

    /// The Chat's activity as the events so far tell it.
    pub fn activity(&self, chat_id: &K) -> Activity {
        self.chats.get(chat_id).map_or(Activity::Idle, Tracked::activity)
    }

    /// How much of the Chat's background work, of the kinds that hold an announcement, still goes on.
    pub fn background(&self, chat_id: &K) -> usize {
        self.chats.get(chat_id).map_or(0, Tracked::background)
    }

    /// Forgets the Chats `drop` picks.
    pub fn forget(&mut self, drop: impl Fn(&K) -> bool) {
        self.chats.retain(|key, _| !drop(key));
        self.order.retain(|key| !drop(key));
    }

    /// Forgets every Chat.
    pub fn forget_all(&mut self) {
        self.forget(|_| true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str) -> Subagent {
        Subagent {
            id: id.to_owned(),
            title: id.to_owned(),
            status: Some("running".to_owned()),
            started_at: Some(10.0),
            ..Subagent::default()
        }
    }

    fn background(id: &str, started_at: f64) -> Subagent {
        Subagent { background: true, started_at: Some(started_at), ..agent(id) }
    }

    fn session(subagents: Vec<Subagent>) -> ActivitySession {
        ActivitySession { provider: Some("claude".to_owned()), subagents, ..ActivitySession::default() }
    }

    fn task(id: &str, kind: &str, started_at: f64) -> BackgroundTask {
        BackgroundTask { id: id.to_owned(), kind: kind.to_owned(), title: format!("{id} title"), started_at: Some(started_at) }
    }

    fn ids(work: &[Work]) -> Vec<&str> {
        work.iter().map(Work::id).collect()
    }

    fn summary(activity: Activity, background: usize, since: Option<f64>) -> ChatActivity {
        ChatActivity { activity, background, since }
    }

    #[test]
    fn activity_of_waiting_then_working_then_failed_then_background_then_idle() {
        let input = ActivityInput::default();
        assert_eq!(activity_of(ActivityInput { running: true, waiting: true, failed: true, background: 2 }), Activity::Waiting);
        assert_eq!(activity_of(ActivityInput { running: true, failed: true, background: 2, ..input }), Activity::Working);
        assert_eq!(activity_of(ActivityInput { failed: true, background: 2, ..input }), Activity::Failed);
        assert_eq!(activity_of(ActivityInput { background: 2, ..input }), Activity::Background);
        assert_eq!(activity_of(input), Activity::Idle);
        // Only a running turn can wait on the user.
        assert_eq!(activity_of(ActivityInput { waiting: true, ..input }), Activity::Idle);
        assert!(activity_busy(Activity::Background) && activity_busy(Activity::Working) && activity_busy(Activity::Waiting));
        assert!(!activity_busy(Activity::Failed) && !activity_busy(Activity::Idle));
    }

    #[test]
    fn chat_activity_counts_the_background_subagents_still_at_work_oldest_first() {
        let chat = ActivitySession {
            native_session_id: Some("parent".to_owned()),
            ..session(vec![
                background("late", 30.0),
                Subagent { status: Some("waiting".to_owned()), ..background("early", 20.0) },
                Subagent { status: Some("completed".to_owned()), ..background("done", 10.0) },
                agent("foreground"),
                background("parent", 10.0),
            ])
        };
        let found: Vec<String> = background_subagents(&chat).into_iter().map(|agent| agent.id).collect();
        assert_eq!(found, ["early", "late"]);
        assert_eq!(chat_activity(&chat, None, None), summary(Activity::Background, 2, Some(20.0)));
        assert_eq!(chat_activity(&chat, Some(RunState::default()), None), summary(Activity::Working, 2, Some(20.0)));
        let asking = RunState { questions: 1, ..RunState::default() };
        assert_eq!(chat_activity(&chat, Some(asking), None).activity, Activity::Waiting);
        let approving = RunState { approvals: 1, ..RunState::default() };
        assert_eq!(chat_activity(&chat, Some(approving), None).activity, Activity::Waiting);
        assert_eq!(chat_activity(&session(vec![]), None, None), summary(Activity::Idle, 0, None));
    }

    #[test]
    fn a_failed_last_turn_wins_over_background_work() {
        let chat = ActivitySession { last_outcome: Some("failed".to_owned()), ..session(vec![background("bg", 10.0)]) };
        assert_eq!(chat_activity(&chat, None, None), summary(Activity::Failed, 1, Some(10.0)));
        // A new turn is work again, and the outcome given explicitly (an older host keeps no summary) counts the same.
        assert_eq!(chat_activity(&chat, Some(RunState::default()), None).activity, Activity::Working);
        assert_eq!(chat_activity(&session(chat.subagents.clone()), None, Some("failed")).activity, Activity::Failed);
        let cancelled = ActivitySession { last_outcome: Some("cancelled".to_owned()), ..session(chat.subagents.clone()) };
        assert_eq!(chat_activity(&cancelled, None, None).activity, Activity::Background);
    }

    #[test]
    fn chat_activity_tracks_background_work_only_for_providers_that_have_it() {
        let subagents = vec![background("bg", 10.0)];
        let on = |provider: Option<&str>| ActivitySession { provider: provider.map(str::to_owned), ..session(subagents.clone()) };
        assert_eq!(chat_activity(&on(Some("codex")), None, None).activity, Activity::Idle);
        assert_eq!(chat_activity(&on(Some("antigravity")), None, None).activity, Activity::Idle);
        // A Chat saved before providers were recorded runs on Claude.
        assert_eq!(chat_activity(&on(None), None, None).activity, Activity::Background);
    }

    #[test]
    fn a_running_advisor_is_background_work_on_any_provider_but_not_a_subagent_its_process_holds() {
        let advisor = Subagent { source: Some(ADVISOR_SOURCE.to_owned()), ..agent("advisor") };
        let chat = ActivitySession { provider: Some("codex".to_owned()), ..session(vec![advisor.clone()]) };
        assert_eq!(chat_activity(&chat, None, None), summary(Activity::Background, 1, Some(10.0)));
        assert!(background_subagents(&chat).is_empty());
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &completed());
        assert_eq!(tracker.observe(&"c", &AgentEvent::SubagentUpdate(advisor)).next, Activity::Background);
    }

    #[test]
    fn background_tasks_the_agent_process_reports_count_after_its_subagents() {
        let chat = ActivitySession {
            background_tasks: vec![task("shell", "local_bash", 20.0), task("mcp", "mcp_task", 40.0)],
            ..session(vec![background("bg", 30.0)])
        };
        assert_eq!(chat_activity(&chat, None, None), summary(Activity::Background, 3, Some(20.0)));
        assert_eq!(ids(&process_work(&chat)), ["shell", "bg", "mcp"]);
        let tasks: Vec<String> = background_tasks(&chat).into_iter().map(|task| task.id).collect();
        assert_eq!(tasks, ["shell", "mcp"]);
        // A Codex Chat's process reports none; a saved set from a Claude turn before a switch doesn't count.
        assert!(background_tasks(&ActivitySession { provider: Some("codex".to_owned()), ..chat.clone() }).is_empty());
        let failed = ActivitySession {
            background_tasks: vec![task("shell", "local_bash", 1.0)],
            last_outcome: Some("failed".to_owned()),
            ..session(vec![])
        };
        assert_eq!(chat_activity(&failed, None, None).activity, Activity::Failed);
    }

    #[test]
    fn background_items_list_the_background_lines_work_oldest_first_with_what_each_is() {
        let advisor = Subagent { source: Some(ADVISOR_SOURCE.to_owned()), started_at: Some(50.0), ..agent("advisor") };
        let chat = ActivitySession {
            background_tasks: vec![task("shell", "local_bash", 20.0), task("flow", "local_workflow", 40.0), task("mcp", "mcp_task", 60.0)],
            ..session(vec![background("bg", 30.0), advisor, agent("foreground")])
        };
        let items = background_items(&chat, &[]);
        let shape: Vec<(BackgroundKind, &str, &str, Option<f64>)> =
            items.iter().map(|item| (item.kind, item.id.as_str(), item.title.as_str(), item.started_at)).collect();
        assert_eq!(
            shape,
            [
                (BackgroundKind::Command, "shell", "shell title", Some(20.0)),
                (BackgroundKind::Subagent, "bg", "bg", Some(30.0)),
                (BackgroundKind::Workflow, "flow", "flow title", Some(40.0)),
                (BackgroundKind::Advisor, "advisor", "advisor", Some(50.0)),
                (BackgroundKind::Task, "mcp", "mcp title", Some(60.0)),
            ]
        );
        // A subagent or advisor carries itself, for its transcript; a task has none.
        assert_eq!(items[1].agent.as_ref(), Some(&chat.subagents[0]));
        assert!(items[0].agent.is_none());
        // The line counts what it lists.
        assert_eq!(items.len(), chat_activity(&chat, None, None).background);
        assert_eq!(BackgroundKind::Advisor.label(), "Advisor");
    }

    #[test]
    fn background_items_leave_out_a_command_that_serves_one_of_the_chats_ports() {
        let chat = ActivitySession {
            background_tasks: vec![task("metro", "local_bash", 10.0), task("tests", "local_bash", 20.0)],
            ..session(vec![])
        };
        let ports = [ChatPort { task_id: Some("metro".to_owned()) }, ChatPort { task_id: None }, ChatPort { task_id: Some(String::new()) }];
        let listed: Vec<String> = background_items(&chat, &ports).into_iter().map(|item| item.id).collect();
        assert_eq!(listed, ["tests"]);
    }

    #[test]
    fn plain_task_output_drops_escape_sequences_and_keeps_a_redrawn_lines_last_state() {
        assert_eq!(plain_task_output(Some("\u{1b}[32m✓\u{1b}[0m build\r\n")), "✓ build\n");
        assert_eq!(plain_task_output(Some("\u{1b}]0;title\u{7} 10%\r 50%\r100% done\nnext")), "100% done\nnext");
        assert_eq!(plain_task_output(Some("\u{1b}[2K\u{1b}[1Gwaiting\u{1b}(B")), "waiting");
        assert_eq!(plain_task_output(None), "");
        // An OSC closed by ESC \, an unterminated one, and a lone ESC.
        assert_eq!(plain_task_output(Some("a\u{1b}]8;;https://x\u{1b}\\link\u{1b}]8;;\u{1b}\\b")), "alinkb");
        assert_eq!(plain_task_output(Some("a\u{1b}]title no end")), "atitle no end");
        assert_eq!(plain_task_output(Some("a\u{1b}")), "a\u{1b}");
        assert_eq!(plain_task_output(Some("\u{1b}[31;1m red \u{1b}[m")), " red ");
    }

    #[test]
    fn background_label_and_the_guards_message() {
        assert_eq!(background_label(1), "1 background task");
        assert_eq!(background_label(3), "3 background tasks");
        assert_eq!(
            background_busy_message(BackgroundAction::Switch, 1, "Codex"),
            "A background task is still running in this Chat. Switching to Codex would stop it. Ask the agent to stop it, or send again once it finishes."
        );
        assert_eq!(
            background_busy_message(BackgroundAction::Reload, 2, ANOTHER_AGENT),
            "2 background tasks are still running in this Chat. Reloading would stop them. Ask the agent to stop them, or reload once they finish."
        );
        assert!(
            background_busy_message(BackgroundAction::Move, 1, ANOTHER_AGENT).contains("can't move to another folder without stopping it")
        );
    }

    #[test]
    fn the_notification_preview_keeps_the_beginning_of_the_latest_reply() {
        assert_eq!(notification_preview(Some("a"), Some("b"), false), "ab");
        assert_eq!(notification_preview(Some("a"), Some("b"), true), "b");
        assert_eq!(notification_preview(None, None, false), "");
        assert_eq!(notification_preview(Some(&"x".repeat(5000)), Some("y"), false).len(), 4096);
    }

    fn delta(text: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: Some(text.to_owned()), starts_message: false }
    }

    fn completed() -> AgentEvent {
        AgentEvent::TurnEnded { end: TurnEnd::Completed, message: None, quiet: false }
    }

    fn quiet(end: TurnEnd) -> AgentEvent {
        AgentEvent::TurnEnded { end, message: Some("Out of credits".to_owned()), quiet: true }
    }

    fn bg(id: &str, status: &str) -> AgentEvent {
        AgentEvent::SubagentUpdate(Subagent { status: Some(status.to_owned()), ..background(id, 10.0) })
    }

    fn body(observed: &Observed) -> Option<&str> {
        observed.completion.as_ref().and_then(|completion| completion.body.as_deref())
    }

    #[test]
    fn tracker_a_plain_turn_announces_its_end_with_the_replys_start() {
        let mut tracker = ActivityTracker::<&str>::default();
        let started = tracker.observe(&"c", &AgentEvent::TurnStarted);
        assert_eq!((started.previous, started.next, started.completion), (Activity::Idle, Activity::Working, None));
        tracker.observe(&"c", &delta("Done "));
        tracker.observe(&"c", &delta("here."));
        let end = tracker.observe(&"c", &completed());
        assert_eq!(end.next, Activity::Idle);
        let completion = end.completion.clone().expect("announced");
        assert_eq!((completion.failed, completion.body.as_deref()), (false, Some("Done here.")));
        assert_eq!(completion.event, completed());
        assert_eq!(tracker.observe(&"c", &completed()).completion, None);
    }

    #[test]
    fn tracker_a_turn_that_ends_while_background_agents_work_announces_once_when_the_last_one_ends() {
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &bg("a", "running"));
        tracker.observe(&"c", &bg("b", "running"));
        tracker.observe(&"c", &delta("Started two agents."));
        let end = tracker.observe(&"c", &completed());
        assert_eq!((end.next, end.completion), (Activity::Background, None));
        assert_eq!(tracker.background(&"c"), 2);
        assert_eq!(tracker.observe(&"c", &bg("a", "completed")).completion, None);
        assert_eq!(tracker.activity(&"c"), Activity::Background);
        let last = tracker.observe(&"c", &bg("b", "completed"));
        assert_eq!((last.previous, last.next, body(&last)), (Activity::Background, Activity::Idle, Some("Started two agents.")));
    }

    #[test]
    fn tracker_the_turn_a_background_result_wakes_announces_its_own_end_and_the_held_one_is_dropped() {
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &bg("a", "running"));
        tracker.observe(&"c", &delta("Started."));
        tracker.observe(&"c", &completed());
        // Claude starts the woken turn before it reports the agent done.
        let woken = tracker.observe(&"c", &AgentEvent::TurnStarted);
        assert_eq!((woken.previous, woken.next, woken.completion), (Activity::Background, Activity::Working, None));
        assert_eq!(tracker.observe(&"c", &bg("a", "completed")).completion, None);
        tracker.observe(&"c", &delta("The agent reported back."));
        assert_eq!(body(&tracker.observe(&"c", &completed())), Some("The agent reported back."));
    }

    #[test]
    fn tracker_a_failure_wins_over_background_work_and_is_announced_at_once() {
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &bg("a", "running"));
        let failed = AgentEvent::TurnEnded { end: TurnEnd::Failed, message: Some("Out of credits".to_owned()), quiet: false };
        let end = tracker.observe(&"c", &failed);
        assert_eq!(
            (end.next, end.completion.as_ref().map(|completion| completion.failed), body(&end)),
            (Activity::Failed, Some(true), Some("Out of credits"))
        );
        // The background agent ending later changes nothing more.
        let later = tracker.observe(&"c", &bg("a", "completed"));
        assert_eq!((later.previous, later.next, later.completion), (Activity::Failed, Activity::Failed, None));
    }

    #[test]
    fn tracker_a_cancelled_turn_announces_nothing_now_or_when_its_background_agents_end() {
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &bg("a", "running"));
        let cancelled = AgentEvent::TurnEnded { end: TurnEnd::Cancelled, message: None, quiet: false };
        assert_eq!(tracker.observe(&"c", &cancelled).completion, None);
        assert_eq!(tracker.observe(&"c", &bg("a", "cancelled")).completion, None);
        assert_eq!(tracker.activity(&"c"), Activity::Idle);
    }

    #[test]
    fn tracker_a_quiet_turn_announces_nothing_now_or_later() {
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &delta("(pass) nothing new"));
        let pass = tracker.observe(&"c", &AgentEvent::TurnEnded { end: TurnEnd::Completed, message: None, quiet: true });
        assert_eq!((pass.next, pass.completion), (Activity::Idle, None));
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &bg("a", "running"));
        assert_eq!(tracker.observe(&"c", &quiet(TurnEnd::Failed)).completion, None);
        assert_eq!(tracker.observe(&"c", &bg("a", "completed")).completion, None);
        // The next ordinary turn still announces its end.
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        assert_eq!(body(&tracker.observe(&"c", &completed())), Some("Turn completed."));
    }

    #[test]
    fn tracker_a_quiet_turn_that_ends_while_background_agents_work_announces_nothing_when_the_last_ends_either() {
        let mut tracker = ActivityTracker::<&str>::default();
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &bg("a", "running"));
        let end = tracker.observe(&"c", &quiet(TurnEnd::Completed));
        assert_eq!((end.next, end.completion), (Activity::Background, None));
        let done = tracker.observe(&"c", &bg("a", "completed"));
        assert_eq!((done.previous, done.next, done.completion), (Activity::Background, Activity::Idle, None));
    }

    #[test]
    fn tracker_requests_make_a_turn_waiting_until_they_are_answered_or_the_turn_ends() {
        let mut tracker = ActivityTracker::<&str>::default();
        let request = |id: &str| Some(id.to_owned());
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        assert_eq!(tracker.observe(&"c", &AgentEvent::PermissionRequest { request_id: request("p") }).next, Activity::Waiting);
        assert_eq!(tracker.observe(&"c", &AgentEvent::PermissionResolved { request_id: request("p") }).next, Activity::Working);
        tracker.observe(&"c", &AgentEvent::QuestionRequest { request_id: request("q") });
        assert_eq!(tracker.observe(&"c", &completed()).next, Activity::Idle);
        // A request with no id counts for nothing, and none is recorded for a Chat that isn't running.
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        assert_eq!(tracker.observe(&"c", &AgentEvent::PermissionRequest { request_id: None }).next, Activity::Working);
        tracker.observe(&"d", &AgentEvent::PermissionRequest { request_id: request("x") });
        assert_eq!(tracker.activity(&"d"), Activity::Idle);
    }

    #[test]
    fn tracker_a_background_command_doesnt_hold_the_turns_announcement_an_mcp_task_does() {
        let mut tracker = ActivityTracker::<&str>::default();
        let tasks = |list: &[(&str, &str)]| AgentEvent::BackgroundTasks(list.iter().map(|(id, kind)| task(id, kind, 1.0)).collect());
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &tasks(&[("server", "local_bash")]));
        tracker.observe(&"c", &delta("The dev server runs."));
        // A server can run for hours: the turn's end is announced at once.
        assert_eq!(body(&tracker.observe(&"c", &completed())), Some("The dev server runs."));
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &tasks(&[("server", "local_bash"), ("export", "mcp_task")]));
        tracker.observe(&"c", &delta("Exporting."));
        let held = tracker.observe(&"c", &completed());
        assert_eq!((held.next, held.completion.clone(), tracker.background(&"c")), (Activity::Background, None, 1));
        let done = tracker.observe(&"c", &tasks(&[("server", "local_bash")]));
        assert_eq!((done.next, body(&done)), (Activity::Idle, Some("Exporting.")));
    }

    #[test]
    fn tracker_a_turn_end_with_no_start_still_means_a_turn_ran() {
        let mut tracker = ActivityTracker::<&str>::default();
        let end = tracker.observe(&"c", &completed());
        assert_eq!((end.previous, end.next), (Activity::Working, Activity::Idle));
        assert_eq!(body(&end), Some("Turn completed."));
    }

    #[test]
    fn tracker_forget_and_its_cap() {
        let mut tracker = ActivityTracker::<&str>::new(2);
        tracker.observe(&"a", &AgentEvent::TurnStarted);
        tracker.observe(&"b", &AgentEvent::TurnStarted);
        tracker.observe(&"c", &AgentEvent::TurnStarted);
        assert_eq!(tracker.activity(&"a"), Activity::Idle);
        tracker.forget(|chat_id| *chat_id == "b");
        assert_eq!((tracker.activity(&"b"), tracker.activity(&"c")), (Activity::Idle, Activity::Working));
        tracker.forget_all();
        assert_eq!(tracker.activity(&"c"), Activity::Idle);
    }

    #[test]
    fn tracker_a_cap_of_zero_follows_nothing() {
        let mut tracker = ActivityTracker::<&str>::new(0);
        let started = tracker.observe(&"a", &AgentEvent::TurnStarted);
        assert_eq!(started.next, Activity::Working);
        assert_eq!(tracker.activity(&"a"), Activity::Idle);
    }
}

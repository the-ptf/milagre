//! The Routines domain (WP-45): `Routine`, `RoutineRun` and `RoutineTrigger` in `packages/shared/src/model.ts` as
//! `routines:list` sends them, plus the small catalogs the form picks from. Plain data; the fixture is at the bottom.
//!
//! A Routine's times are milliseconds since the epoch, like the rest of `data`. Another computer's Routine carries its
//! computer's id in `computer` (the TypeScript qualifies the Routine's id instead; the GPUI port keeps them apart).

use crate::data::{Millis, Provider};

/// The id `This Mac` has in `computer` (`LOCAL_COMPUTER` in `chat-scopes`).
pub const LOCAL: &str = "local";

/// The Linear event a trigger watches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinearEvent {
    LabelAdded,
    Assigned,
    State,
    Comment,
}

impl LinearEvent {
    pub const ALL: [LinearEvent; 4] = [LinearEvent::LabelAdded, LinearEvent::Assigned, LinearEvent::State, LinearEvent::Comment];

    /// The wire id.
    pub fn id(self) -> &'static str {
        match self {
            LinearEvent::LabelAdded => "label-added",
            LinearEvent::Assigned => "assigned",
            LinearEvent::State => "state",
            LinearEvent::Comment => "comment",
        }
    }

    pub fn from_id(id: &str) -> Option<LinearEvent> {
        LinearEvent::ALL.into_iter().find(|event| event.id() == id)
    }

    /// The form's When menu (`LINEAR_WHEN`).
    pub fn label(self) -> &'static str {
        match self {
            LinearEvent::LabelAdded => "Label added",
            LinearEvent::Assigned => "Assigned to me",
            LinearEvent::State => "Moved to a state",
            LinearEvent::Comment => "New comment",
        }
    }
}

/// `RoutineTrigger`: what starts a Routine.
#[derive(Clone, Debug, PartialEq)]
pub enum Trigger {
    Schedule {
        cron: String,
        timezone: String,
    },
    Linear {
        workspace: String,
        event: LinearEvent,
        team: Option<String>,
        label: Option<String>,
        state: Option<String>,
    },
    Webhook {
        hook_id: String,
        signed: bool,
    },
    /// A babysit Heartbeat: it runs on what changed on its PR.
    PullRequest {
        number: u32,
    },
}

/// Where a new Chat's Run works.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workspace {
    Worktree,
    Project,
}

/// `RoutineTarget`.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// A Heartbeat: it checks back on one Chat.
    Chat {
        chat_id: String,
    },
    NewChat {
        project_path: String,
        workspace: Workspace,
    },
}

/// The model a failed Run retries on.
#[derive(Clone, Debug, PartialEq)]
pub struct Fallback {
    pub provider: Provider,
    pub model: String,
    pub effort: Option<String>,
}

/// A flow Routine's mark in the list. The Flow page itself is WP-46.
#[derive(Clone, Debug, PartialEq)]
pub struct FlowInfo {
    /// 0 before the first publish.
    pub revision: u32,
    /// Runs waiting on someone's approval.
    pub waiting: u32,
}

/// A Run's outcome (`RoutineRun.status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStatus {
    Acted,
    Quiet,
    Failed,
    Running,
    SkippedBusy,
    Missed,
    Ended,
}

/// An attempt that failed and was retried on the fallback.
#[derive(Clone, Debug, PartialEq)]
pub struct Attempt {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub error: Option<String>,
    pub ended_at: Millis,
    pub chat_id: Option<String>,
}

/// The model a Run ended up on after a retry.
#[derive(Clone, Debug, PartialEq)]
pub struct RunFallback {
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// A Linear issue a Run was started for.
#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub key: String,
    pub title: Option<String>,
}

/// `RoutineRun`.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub id: String,
    pub started_at: Millis,
    pub ended_at: Option<Millis>,
    pub status: RunStatus,
    /// Refused before it ran (a webhook over its rate limit).
    pub rejected: bool,
    pub summary: Option<String>,
    pub title: Option<String>,
    pub error: Option<String>,
    pub chat_id: Option<String>,
    pub issue: Option<Issue>,
    pub attempts: Vec<Attempt>,
    pub fallback: Option<RunFallback>,
}

impl Run {
    pub fn new(id: impl Into<String>, started_at: Millis, status: RunStatus) -> Self {
        Run {
            id: id.into(),
            started_at,
            ended_at: None,
            status,
            rejected: false,
            summary: None,
            title: None,
            error: None,
            chat_id: None,
            issue: None,
            attempts: Vec::new(),
            fallback: None,
        }
    }
}

/// `Routine` with its latest Runs (`RoutineWithRuns`), newest first.
#[derive(Clone, Debug, PartialEq)]
pub struct Routine {
    pub id: String,
    /// The computer it runs on.
    pub computer: String,
    pub name: String,
    pub prompt: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub target: Target,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub fallback: Option<Fallback>,
    pub max_runs: Option<u32>,
    pub expires_at: Option<Millis>,
    pub run_count: u32,
    pub next_run_at: Option<Millis>,
    pub last_run_at: Option<Millis>,
    pub last_error: Option<String>,
    pub paused_reason: Option<String>,
    pub signing_header: Option<String>,
    pub flow: Option<FlowInfo>,
    pub runs: Vec<Run>,
}

impl Routine {
    pub fn new(id: impl Into<String>, name: impl Into<String>, trigger: Trigger, target: Target) -> Self {
        Routine {
            id: id.into(),
            computer: LOCAL.into(),
            name: name.into(),
            prompt: String::new(),
            enabled: true,
            trigger,
            target,
            provider: None,
            model: None,
            permission_mode: None,
            fallback: None,
            max_runs: None,
            expires_at: None,
            run_count: 0,
            next_run_at: None,
            last_run_at: None,
            last_error: None,
            paused_reason: None,
            signing_header: None,
            flow: None,
            runs: Vec::new(),
        }
    }
}

/// A model the form can pick (the catalog is the composer's; this is the slice a Routine needs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelChoice {
    pub provider: Provider,
    pub id: &'static str,
    pub name: &'static str,
    pub efforts: &'static [&'static str],
}

const MODERN: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const CODEX: &[&str] = &["low", "medium", "high"];

/// The models the Routine form lists, in picker order.
pub fn model_choices() -> Vec<ModelChoice> {
    use Provider::{Claude, Codex};
    vec![
        ModelChoice { provider: Codex, id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: CODEX },
        ModelChoice { provider: Codex, id: "gpt-6-luna", name: "GPT-6-Luna", efforts: CODEX },
        ModelChoice { provider: Claude, id: "claude-opus-5-5", name: "Opus 5.5", efforts: MODERN },
        ModelChoice { provider: Claude, id: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: MODERN },
        ModelChoice { provider: Claude, id: "claude-haiku-4-5", name: "Haiku 4.5", efforts: &[] },
    ]
}

/// The name a model has in the picker, else its id.
pub fn model_name(provider: Option<Provider>, id: &str) -> String {
    model_choices()
        .into_iter()
        .find(|model| model.id == id && provider.is_none_or(|p| p == model.provider))
        .map_or(id.to_string(), |m| m.name.to_string())
}

/// A Project the form can target, with the Chats a Heartbeat can check back on.
#[derive(Clone, Debug, PartialEq)]
pub struct TargetProject {
    pub path: String,
    pub name: String,
    pub computer: String,
    pub chats: Vec<(String, String)>,
}

/// `routines:targets` for the fixture.
pub fn targets() -> Vec<TargetProject> {
    let chat = |id: &str, title: &str| (id.to_string(), title.to_string());
    vec![
        TargetProject {
            path: "/Users/victor/Code/personal/milagre-ade".into(),
            name: "milagre-ade".into(),
            computer: LOCAL.into(),
            chats: vec![
                chat("/Users/victor/Code/personal/milagre-ade#c1", "Notification chimes"),
                chat("/Users/victor/Code/personal/milagre-ade#c2", "Routines visual pass"),
            ],
        },
        TargetProject {
            path: "/Users/victor/Code/personal/happiergym".into(),
            name: "happiergym".into(),
            computer: LOCAL.into(),
            chats: vec![chat("/Users/victor/Code/personal/happiergym#c3", "Watch connectivity")],
        },
        TargetProject {
            path: "/Users/victor/Code/payments-api".into(),
            name: "payments-api".into(),
            computer: "studio".into(),
            chats: vec![],
        },
    ]
}

/// A paired computer's name by id.
pub fn computer_name(id: &str) -> String {
    match id {
        LOCAL => "This Mac".into(),
        "studio" => "Studio".into(),
        other => other.to_string(),
    }
}

/// A Linear workspace's teams, labels and states (`routines:linear-options`).
#[derive(Clone, Debug, PartialEq)]
pub struct LinearOptions {
    pub teams: Vec<(String, String)>,
    pub labels: Vec<String>,
    pub states: Vec<String>,
}

pub fn linear_options() -> LinearOptions {
    LinearOptions {
        teams: vec![("MIL".into(), "Milagre".into()), ("HGY".into(), "Happiergym".into())],
        labels: vec!["agent".into(), "bug".into(), "needs-spec".into()],
        states: vec!["Todo".into(), "In Progress".into(), "In Review".into(), "Done".into()],
    }
}

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;
pub const MINUTE_MS: i64 = 60_000;

/// "Now" of the fixture and the snapshots: Wed 2026-11-11 12:05 (the zone is `words::ZONE`, UTC).
pub fn fixture_now() -> Millis {
    crate::logic::usage::time::epoch_ms(2026, 11, 11, 12, 5, 0)
}

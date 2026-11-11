//! What the pills show: fixture data in the shapes the host will send. Fixture only, until the DataSource has
//! `plan`, `ports` and `subagents` (PORT-MAP K-14: "plan, ports").

use crate::logic::activity::subagent_glance::{Step, ToolCounts};
use crate::logic::activity::subchat_states::{
    AgentQuestion, ApprovalRequest, Heartbeat, QuestionOption, QuestionRequest, SubchatInput, SubchatRun, SubchatState, subchat_state,
};
use crate::logic::plan::{ChatPlan, ChatTask, Phase, PhaseEntry, TaskStatus};

/// The clock the fixture's times count from (ms). Also the plan graph's Now when it opens.
pub const NOW: i64 = 1_800_000_000_000;
const MIN: i64 = 60_000;
const HOUR: i64 = 3_600_000;

/// `AgentPort` (`model.ts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PortRow {
    pub port: u16,
    pub pid: u32,
    pub command: String,
    /// Another computer's name, when the port is not on this one.
    pub computer: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentStatus {
    Initializing,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

impl AgentStatus {
    pub fn label(self) -> &'static str {
        match self {
            AgentStatus::Initializing => "Starting",
            AgentStatus::Running => "Running",
            AgentStatus::Waiting => "Waiting",
            AgentStatus::Completed => "Completed",
            AgentStatus::Failed => "Failed",
            AgentStatus::Cancelled => "Stopped",
            AgentStatus::Unknown => "Status unavailable",
        }
    }

    /// `subagentActive`.
    pub fn active(self) -> bool {
        matches!(self, AgentStatus::Initializing | AgentStatus::Running | AgentStatus::Waiting)
    }

    /// `subagentFinished`.
    pub fn finished(self) -> bool {
        matches!(self, AgentStatus::Completed | AgentStatus::Failed | AgentStatus::Cancelled)
    }
}

/// `AgentTask`: a subagent's own to-do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTask {
    pub id: String,
    pub content: String,
    pub active_form: Option<String>,
    pub status: TaskStatus,
}

/// `Subagent` (`model.ts`), with what `useSubagentDetails` reads from its transcript already folded in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subagent {
    pub id: String,
    pub title: String,
    pub status: AgentStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub said: Option<String>,
    pub outcome: Option<String>,
    pub result: Option<String>,
    pub tasks: Vec<AgentTask>,
    pub tools: ToolCounts,
    pub steps: u32,
    pub role: Option<String>,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub transcript: Vec<Step>,
    pub latest_tool: Option<String>,
    pub archived: bool,
}

/// Everything the pill row shows for one Chat.
#[derive(Clone, Debug, Default)]
pub struct PillsData {
    pub plan: Option<ChatPlan>,
    pub ports: Vec<PortRow>,
    pub subchats: Vec<SubchatState>,
    pub subagents: Vec<Subagent>,
    pub now: i64,
}

fn hash(key: &str) -> u64 {
    key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

fn task(id: &str, title: &str, status: TaskStatus) -> ChatTask {
    ChatTask::new(id, title, status)
}

fn plan() -> ChatPlan {
    let mut build = task("2", "Fix the hang", TaskStatus::InProgress);
    build.children = vec![
        task("2.1", "Find the layer that never fires transitionend", TaskStatus::Completed),
        ChatTask { active_form: Some("Adding the timer fallback".into()), ..task("2.2", "Add a timer fallback", TaskStatus::InProgress) },
        task("2.3", "Cover it with a check", TaskStatus::Pending),
    ];
    ChatPlan {
        tasks: vec![task("1", "Reproduce the hang on Linux", TaskStatus::Completed), build, task("3", "Open the PR", TaskStatus::Pending)],
        phases: vec![
            PhaseEntry { phase: Phase::Start, at: NOW - 5 * HOUR },
            PhaseEntry { phase: Phase::Plan, at: NOW - 5 * HOUR + 12 * MIN },
            PhaseEntry { phase: Phase::Build, at: NOW - 5 * HOUR + 40 * MIN },
            PhaseEntry { phase: Phase::Test, at: NOW - 100 * MIN },
            PhaseEntry { phase: Phase::Build, at: NOW - 70 * MIN },
        ],
    }
}

fn ports() -> Vec<PortRow> {
    vec![
        PortRow { port: 5173, pid: 4121, command: "vite".into(), computer: None },
        PortRow { port: 8787, pid: 4188, command: "wrangler dev".into(), computer: None },
        PortRow { port: 3000, pid: 911, command: "next dev".into(), computer: Some("deer".into()) },
    ]
}

fn question(id: &str, text: &str, options: &[&str]) -> QuestionRequest {
    QuestionRequest {
        request_id: id.into(),
        questions: vec![AgentQuestion {
            id: "q1".into(),
            header: String::new(),
            question: text.into(),
            options: options.iter().map(|label| QuestionOption { label: (*label).into(), description: None }).collect(),
            multi_select: false,
            allow_other: false,
            secret: false,
        }],
    }
}

fn subchats() -> Vec<SubchatState> {
    let run = |text: &str, started: i64| SubchatRun { text: Some(text.into()), started_at: Some(NOW - started), ..Default::default() };
    let inputs = [
        SubchatInput {
            key: "milagre#41".into(),
            title: "Align the data layer with the app".into(),
            run: Some(SubchatRun {
                questions: vec![question("r1", "Which badge should Closed use?", &["Neutral (Recommended)", "Red", "Muted"])],
                ..run("Waiting on a choice.", 3 * MIN + 5_000)
            }),
            ..Default::default()
        },
        SubchatInput {
            key: "milagre#42".into(),
            title: "Port the sidebar to GPUI".into(),
            run: Some(run("Moving the Pinned rows to a uniform list.", 11 * MIN + 42_000)),
            ..Default::default()
        },
        SubchatInput {
            key: "milagre#43".into(),
            title: "Sidebar snapshot check".into(),
            run: Some(SubchatRun {
                approvals: vec![ApprovalRequest { request_id: "a1".into(), title: "Run `cargo test`".into() }],
                ..run("Wants to run a command.", 40_000)
            }),
            ..Default::default()
        },
        SubchatInput { key: "milagre#44".into(), title: "Write the pill tests".into(), queued: true, ..Default::default() },
        SubchatInput {
            key: "milagre#45".into(),
            title: "Watch the nightly build".into(),
            heartbeat: Some(Heartbeat { next_run_at: Some(NOW + 25 * MIN), run_count: Some(3), max_runs: Some(12) }),
            ..Default::default()
        },
        SubchatInput {
            key: "milagre#46".into(),
            title: "Audit the relay".into(),
            report: Some("Relay finished: no refused dials left.".into()),
            ..Default::default()
        },
    ];
    inputs.iter().map(|input| subchat_state(input, NOW)).collect()
}

fn step(id: &str, said: &str, tools: &[(crate::logic::activity::subagent_glance::ToolCategory, u32)], last: Option<&str>) -> Step {
    Step { id: id.into(), said: said.into(), text: said.into(), tools: ToolCounts::of(tools), last_tool: last.map(Into::into) }
}

fn subagents() -> Vec<Subagent> {
    use crate::logic::activity::subagent_glance::ToolCategory::{Commands, Edits, Reads, Searches};
    let agent = |id: &str, title: &str, status: AgentStatus| Subagent {
        id: id.into(),
        title: title.into(),
        status,
        started_at: NOW - 6 * MIN,
        ended_at: None,
        said: None,
        outcome: None,
        result: None,
        tasks: vec![],
        tools: ToolCounts::default(),
        steps: 0,
        role: None,
        model: None,
        prompt: None,
        transcript: vec![],
        latest_tool: None,
        archived: false,
    };
    let task = |id: &str, content: &str, active: Option<&str>, status| AgentTask {
        id: id.into(),
        content: content.into(),
        active_form: active.map(Into::into),
        status,
    };
    vec![
        Subagent {
            said: Some("Reading the Dawn intro's transition code.".into()),
            tools: ToolCounts::of(&[(Reads, 6), (Searches, 2)]),
            steps: 3,
            role: Some("Explorer".into()),
            model: Some("Opus 5.5".into()),
            prompt: Some(
                "Find every place the intro waits on transitionend and say which ones can hang on a compositor that skips it.".into(),
            ),
            transcript: vec![
                step("s1", "Looking for transitionend listeners.", &[(Searches, 2)], Some("Searched for `transitionend`")),
                step("s2", "Reading the Dawn intro's transition code.", &[(Reads, 6)], Some("Read `intro/Dawn.tsx`")),
            ],
            latest_tool: Some("Read `intro/Dawn.tsx`".into()),
            ..agent("a1", "Map the intro's waits", AgentStatus::Running)
        },
        Subagent {
            said: Some("Writing the timer fallback.".into()),
            tasks: vec![
                task("t1", "Read the intro", None, TaskStatus::Completed),
                task("t2", "Add the timer", Some("Adding the timer"), TaskStatus::InProgress),
                task("t3", "Run the check", None, TaskStatus::Pending),
            ],
            tools: ToolCounts::of(&[(Reads, 4), (Edits, 1)]),
            steps: 4,
            model: Some("Opus 5.5".into()),
            prompt: Some("Add a timer fallback to the star layer.".into()),
            latest_tool: Some("Edited `intro/Dawn.tsx`".into()),
            ..agent("a2", "Add the fallback", AgentStatus::Running)
        },
        Subagent {
            ended_at: Some(NOW - 2 * MIN),
            outcome: Some("The onboarding check passes on Linux.".into()),
            result: Some("The onboarding check passes on Linux.\n\nThe timer fires after 1.2s when `transitionend` never arrives.".into()),
            tools: ToolCounts::of(&[(Commands, 2), (Reads, 3)]),
            steps: 5,
            role: Some("Verifier".into()),
            prompt: Some("Run the onboarding check and report.".into()),
            transcript: vec![step(
                "s1",
                "Running the onboarding check.",
                &[(Commands, 2)],
                Some("Ran `npm test -- --only test-onboarding`"),
            )],
            ..agent("a3", "Run the onboarding check", AgentStatus::Completed)
        },
        Subagent {
            ended_at: Some(NOW - 4 * MIN),
            said: Some("The Windows runner is offline.".into()),
            ..agent("a4", "Try it on Windows", AgentStatus::Failed)
        },
        Subagent {
            ended_at: Some(NOW - 30 * MIN),
            outcome: Some("Nothing left to clean.".into()),
            archived: true,
            ..agent("a5", "Clean the build cache", AgentStatus::Completed)
        },
    ]
}

/// The default fixture Chat's pills: every pill there is. Other Chats get some of them, chosen from the key, so
/// switching Chats visibly changes the row.
pub fn pills_for(key: &str, title: &str) -> PillsData {
    let all = PillsData { plan: Some(plan()), ports: ports(), subchats: subchats(), subagents: subagents(), now: NOW };
    if title == crate::workspace::chat::fixture::DEFAULT_TITLE {
        return all;
    }
    let h = hash(key);
    PillsData {
        plan: (h & 1 == 0).then(|| ChatPlan { phases: all.plan.as_ref().map(|p| p.phases.clone()).unwrap_or_default(), tasks: vec![] }),
        ports: if h & 2 == 0 { all.ports[..1].to_vec() } else { vec![] },
        subchats: if h & 4 == 0 { all.subchats[1..3].to_vec() } else { vec![] },
        subagents: if h & 8 == 0 { all.subagents[2..4].to_vec() } else { vec![] },
        now: NOW,
    }
}

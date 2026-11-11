//! The fixture backend: three computers (this Mac, an offline one and an online one), their Projects and Chats
//! homes, and in them Chats in every state the lists show: running, waiting on an approval, asking, unread, failed,
//! background work, pinned, Done, archived, Subchat families (one opened, one folded), a Routine's Run Chats (one
//! hidden and idle, one hidden but waiting, one kept), PRs in every state, and plan usage with a failed read, a
//! warning and a critical window. [`FixtureSource`] serves it through [`DataSource`] the way the daemons would.
//!
//! The Chats named in [`FixtureData::build`] are the screen the sidebar is judged on; the rest come from small
//! tables and a fixed LCG, so every run and test sees the same lists. The All Chats list (pinned rows, then every
//! listed top-level Chat and the opened family's Subchats) holds exactly [`LISTED_ROWS`] rows.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::anyhow;
use gpui::{Rgba, SharedString};

use super::source::ready;
use super::*;
use crate::theme::hex;

/// Rows in the sidebar's All Chats list, pinned ones included, with the fixture's opened families.
pub const LISTED_ROWS: usize = 500;
/// Chats in the Done list.
pub const DONE_CHATS: usize = 35;
/// The fixture's clock: 2026-11-11T10:00:00Z.
pub const NOW: Millis = 1_794_391_200_000;
const MINUTE: Millis = 60_000;
const EPOCH: &str = "3f0c9a52-6d1e-4b7a-9e2f-1c8d5a7b4e60";

pub const THIS_MAC: &str = "Victor XPro";
/// A paired computer that is offline: its states come from the last copy (`computers:recall`), its runs are unknown.
pub const TIANXU: &str = "tianxu-mini";
/// A paired computer that is online.
pub const DEER: &str = "deer-studio";

/// One Project (or Chats home) of the fixture: its computer, name, tile, origin and whether it is hidden.
struct ProjectSpec {
    computer: &'static str,
    path: &'static str,
    name: &'static str,
    tile: Option<Rgba>,
    origin: Option<&'static str>,
    hidden: bool,
    git: bool,
    kind: ProjectKind,
}

const fn project(
    computer: &'static str,
    path: &'static str,
    name: &'static str,
    tile: Option<Rgba>,
    origin: Option<&'static str>,
) -> ProjectSpec {
    ProjectSpec { computer, path, name, tile, origin, hidden: false, git: true, kind: ProjectKind::Project }
}

/// A computer's Chats home: the internal repository its Chats without a Project run in.
const fn home(computer: &'static str, path: &'static str) -> ProjectSpec {
    ProjectSpec { computer, path, name: "Chats", tile: None, origin: None, hidden: false, git: true, kind: ProjectKind::ChatsHome }
}

/// Every scope, each computer's in its recent order with its Chats home last.
const PROJECTS: [ProjectSpec; 10] = [
    project(LOCAL, "/fixture/milagre-ade", "milagre-ade", None, Some("github.com/the-ptf/milagre-ade")),
    project(LOCAL, "/fixture/happiergym", "happiergym", Some(hex("#1f9d6b")), Some("github.com/victor/happiergym")),
    project(LOCAL, "/fixture/site", "site", None, Some("github.com/the-ptf/site")),
    ProjectSpec { hidden: true, ..project(LOCAL, "/fixture/scratch", "scratch", None, None) },
    home(LOCAL, "/fixture/chats"),
    project(TIANXU, "/fixture/tianxu/milagre", "milagre", Some(hex("#2b4fd6")), Some("github.com/the-ptf/milagre")),
    project(TIANXU, "/fixture/tianxu/milagre-ade", "milagre-ade", None, Some("github.com/the-ptf/milagre-ade")),
    project(DEER, "/fixture/deer/rd-car", "rd-car", Some(hex("#5b46d6")), Some("github.com/rdcar/rd-car")),
    home(DEER, "/fixture/deer/chats"),
    // A plain folder on deer, outside Git.
    ProjectSpec { git: false, ..project(DEER, "/fixture/deer/notes", "notes", None, None) },
];
const ADE: usize = 0;
const HAPPIERGYM: usize = 1;
const SITE: usize = 2;
const SCRATCH: usize = 3;
const HOME: usize = 4;
const MILAGRE: usize = 5;
const ADE_COPY: usize = 6;
const RD_CAR: usize = 7;
const DEER_HOME: usize = 8;
const NOTES: usize = 9;
/// The scopes filler Chats go to (not the hidden one).
const FILLER_SCOPES: [usize; 9] = [ADE, HAPPIERGYM, SITE, HOME, MILAGRE, ADE_COPY, RD_CAR, DEER_HOME, NOTES];

/// What a Chat's live turn waits on, if it has one.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Live {
    #[default]
    Idle,
    Working,
    /// An approval for this command.
    Approval(&'static str),
    /// A question.
    Question(&'static str),
}

/// One Chat to build. Times are minutes before [`NOW`].
#[derive(Clone, Debug)]
struct Spec {
    scope: usize,
    title: String,
    created: i64,
    count: usize,
    live: Live,
    unread: bool,
    outcome: Option<Outcome>,
    pin: Option<f64>,
    done: Option<i64>,
    archived: bool,
    /// The spec this one is a Subchat of.
    parent: Option<usize>,
    /// `Some(hidden)` for a Chat a Routine's Run made.
    routine: Option<Option<bool>>,
    prs: Vec<u32>,
    provider: Provider,
    /// Background subagents still at work.
    background: usize,
    /// Background commands still running.
    commands: Vec<&'static str>,
}

impl Default for Spec {
    fn default() -> Self {
        Spec {
            scope: ADE,
            title: String::new(),
            created: 0,
            count: 12,
            live: Live::Idle,
            unread: false,
            outcome: Some(Outcome::Completed),
            pin: None,
            done: None,
            archived: false,
            parent: None,
            routine: None,
            prs: Vec::new(),
            provider: Provider::Claude,
            background: 0,
            commands: Vec::new(),
        }
    }
}

/// One scope of the fixture: its Project, its state and its PRs.
#[derive(Clone, Debug)]
pub struct FixtureScope {
    pub project: Project,
    pub state: ScopeState,
    pub pull_requests: PullRequestSnapshot,
}

impl FixtureScope {
    pub fn scope(&self) -> ScopeKey {
        self.project.scope()
    }
}

/// Everything the fixture knows, built once.
pub struct FixtureData {
    pub computers: ComputersSnapshot,
    pub scopes: Vec<FixtureScope>,
    /// `chat:runs` of each computer that answers (an offline one does not).
    pub runs: BTreeMap<SharedString, ChatRuns>,
    pub usage: UsageSnapshot,
    /// The Subchat families this Mac opened, by the parent's Chat key (the desktop keeps them in
    /// `milagre.subchatsOpen`); every other family starts folded.
    pub open_families: Vec<String>,
    /// The Chat the window shows (the Chat column's fixture), by key.
    pub open_chat: String,
    /// The scope `project:current` answers with.
    pub current: usize,
}

impl Default for FixtureData {
    fn default() -> Self {
        Self::new()
    }
}

/// The deterministic draws filler Chats are made from (the spike's first fixture's generator).
struct Lcg(u32);

impl Lcg {
    fn next(&mut self) -> usize {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.0 >> 8) as usize
    }
}

impl FixtureData {
    pub fn new() -> Self {
        let mut specs = Self::build();
        let open = specs.iter().position(|spec| spec.title == "Migrate desktop to Rust PoC").expect("the opened family's parent");
        let shown = |specs: &[Spec]| specs.iter().filter(|spec| shown_in_list(specs, spec, open)).count();
        // Filler: plain listed Chats, older than every named one, until the list holds LISTED_ROWS rows.
        const TOPICS: [&str; 12] = [
            "Relay Durable Object backoff",
            "Sidebar undo toast on iPad",
            "Workout export to HealthKit",
            "Landing page Lighthouse budget",
            "Live Activity for rest timer",
            "Forced-close receipts",
            "Settings search index",
            "Chat switch panel flash",
            "Storage cleanup worktrees",
            "Browser upload tool",
            "Routines visual pass",
            "Perf harness soak",
        ];
        let mut lcg = Lcg(0x9e37_79b9);
        let mut n = shown(&specs);
        while n < LISTED_ROWS {
            let scope = FILLER_SCOPES[lcg.next() % FILLER_SCOPES.len()];
            let topic = TOPICS[lcg.next() % TOPICS.len()];
            let (live, unread, outcome) = match lcg.next() % 12 {
                0 => (Live::Working, false, None),
                1 => (Live::Approval("cargo test --workspace"), false, None),
                2 => (Live::Question("Keep the old behaviour behind a setting?"), false, None),
                3 => (Live::Idle, false, Some(Outcome::Failed)),
                4 | 5 => (Live::Idle, true, Some(Outcome::Completed)),
                _ => (Live::Idle, false, Some(Outcome::Completed)),
            };
            let prs = if lcg.next().is_multiple_of(3) { vec![900 + (lcg.next() % 200) as u32] } else { Vec::new() };
            let provider = match n % 13 {
                0 | 5 => Provider::Codex,
                7 => Provider::Antigravity,
                11 => Provider::Kiro,
                _ => Provider::Claude,
            };
            specs.push(Spec {
                scope,
                title: format!("{topic} {n}"),
                created: 600 + n as i64 * 23,
                count: 2 + n % 37,
                live,
                unread,
                outcome,
                prs,
                provider,
                ..Spec::default()
            });
            n += 1;
        }
        debug_assert_eq!(shown(&specs), LISTED_ROWS);
        Self::assemble(&specs, open)
    }

    /// The named Chats. Times are minutes ago; a Subchat is newer than its parent.
    fn build() -> Vec<Spec> {
        let mut specs: Vec<Spec> = Vec::new();
        let mut push = |spec: Spec| {
            specs.push(spec);
            specs.len() - 1
        };
        let named = |scope: usize, title: &str, created: i64| Spec { scope, title: title.to_owned(), created, ..Spec::default() };

        // Pinned: in the Pinned section above All Chats, in their pin order.
        push(Spec { pin: Some(0.0), prs: vec![1022], ..named(ADE, "Release train v0.233", 2_000) });
        push(Spec { pin: Some(1.0), background: 2, ..named(ADE, "Relay Durable Object backoff", 3_000) });

        // The first screen of All Chats.
        let migrate = push(Spec { live: Live::Working, outcome: None, ..named(ADE, "Migrate desktop to Rust PoC", 6) });
        let port = push(Spec { parent: Some(migrate), live: Live::Working, outcome: None, ..named(ADE, "Port the sidebar to GPUI", 5) });
        push(Spec {
            parent: Some(migrate),
            live: Live::Question("Re-export the logic types or convert at the edge?"),
            outcome: None,
            ..named(ADE, "Align the data layer with the app", 4)
        });
        push(Spec { parent: Some(port), unread: true, ..named(ADE, "Sidebar snapshot check", 3) });
        push(Spec {
            live: Live::Approval("npm test -- --only test-onboarding"),
            outcome: None,
            prs: vec![1020],
            ..named(ADE, "Fix Linux onboarding intro hang", 8)
        });
        push(Spec { unread: true, ..named(MILAGRE, "Fix Windows port listener cleanup", 12) });
        push(Spec {
            live: Live::Working,
            outcome: None,
            prs: vec![1015, 1014, 1016, 1020],
            ..named(ADE, "Codebase analysis and fixes", 15)
        });
        push(Spec { live: Live::Question("Which plan should the fleet report use?"), outcome: None, ..named(RD_CAR, "RDCar ops", 20) });
        push(Spec { unread: true, ..named(DEER_HOME, "Gestor RDCar", 25) });
        let issues = push(named(ADE, "Identify issues to close", 30));
        push(Spec { parent: Some(issues), ..named(ADE, "Close stale Linear issues", 29) });
        push(Spec {
            parent: Some(issues),
            live: Live::Question("Close the 14 issues older than a year?"),
            outcome: None,
            ..named(ADE, "Triage GitHub issues", 28)
        });
        push(Spec { outcome: Some(Outcome::Failed), ..named(ADE, "Rust terminal owner migration", 40) });
        // A Routine's Run: hidden, but listed while it waits on an approval.
        push(Spec {
            routine: Some(Some(true)),
            live: Live::Approval("npm outdated --json"),
            outcome: None,
            ..named(HAPPIERGYM, "Nightly dependency check", 45)
        });
        // The Run before it: hidden and idle, so never listed.
        push(Spec { routine: Some(Some(true)), ..named(HAPPIERGYM, "Nightly dependency check", 1_485) });
        // A Run Chat the user kept (pinned once, so the host stopped hiding it).
        push(Spec { routine: Some(Some(false)), prs: vec![1013], ..named(ADE, "Babysit PR #1013", 50) });
        push(Spec { commands: vec!["npm run dev"], ..named(HAPPIERGYM, "Live Activity for rest timer", 60) });
        push(Spec { unread: true, provider: Provider::Codex, prs: vec![1010], ..named(SITE, "Landing page Lighthouse budget", 75) });
        push(Spec { provider: Provider::Kiro, prs: vec![1005], ..named(ADE_COPY, "Chat switch panel flash", 90) });
        push(Spec { provider: Provider::Antigravity, ..named(NOTES, "Meeting notes cleanup", 110) });

        // Done: marked over the last ten hours, most recent first in the Done list.
        for i in 0..DONE_CHATS {
            let scope = FILLER_SCOPES[i % FILLER_SCOPES.len()];
            push(Spec {
                done: Some(10 + i as i64 * 17),
                ..named(scope, &format!("Finished: release note {}", 100 + i), 900 + i as i64 * 41)
            });
        }
        // Archived, and never listed.
        for (i, scope) in FILLER_SCOPES.iter().take(5).enumerate() {
            push(Spec { archived: true, ..named(*scope, &format!("Archived experiment {i}"), 20_000 + i as i64) });
        }
        // Chats in the hidden Project: not in the all-Projects sidebar.
        for i in 0..3 {
            push(named(SCRATCH, &format!("Scratch idea {i}"), 400 + i as i64));
        }
        // A Worktree's empty starter Chat in every scope: no message, never listed.
        for scope in 0..PROJECTS.len() {
            push(Spec { count: 0, outcome: None, ..named(scope, "", 30_000) });
        }
        specs
    }

    /// Turns the specs into scopes (ids in creation order), runs and usage.
    fn assemble(specs: &[Spec], open: usize) -> Self {
        let mut scopes: Vec<FixtureScope> = PROJECTS.iter().map(new_scope).collect();
        // Ids grow with time in each scope, as the host's do.
        let mut order: Vec<usize> = (0..specs.len()).collect();
        order.sort_by_key(|&ix| std::cmp::Reverse(specs[ix].created));
        let mut ids = vec![0 as ChatId; specs.len()];
        for &ix in &order {
            let state = &mut scopes[specs[ix].scope].state;
            state.next_id += 1;
            ids[ix] = state.next_id;
        }
        let mut runs: BTreeMap<SharedString, ChatRuns> = BTreeMap::new();
        for (ix, spec) in specs.iter().enumerate() {
            let id = ids[ix];
            let parent = spec.parent.map(|parent| ids[parent]);
            let scope = &mut scopes[spec.scope];
            let worktree = worktree_for(&scope.project, id, &spec.title);
            let chat = chat_for(spec, id, parent, &worktree);
            for number in &spec.prs {
                let pr = pull_request(&scope.project, *number);
                scope.pull_requests.chats.entry(worktree.path.clone()).or_default().insert(pr.url.clone().into(), Some(pr));
            }
            if spec.live != Live::Idle && !spec.archived && spec.done.is_none() {
                let entry = runs.entry(scope.project.computer.clone()).or_insert_with(|| ChatRuns { seq: 1, ..ChatRuns::default() });
                entry.runs.insert(scope.scope().chat_key(id), run_for(spec));
                entry.seq += 1;
            }
            scope.state.worktrees.insert(worktree.id, worktree);
            scope.state.sessions.insert(id, chat);
        }
        let computers = ComputersSnapshot {
            this_mac: THIS_MAC.into(),
            computers: vec![
                Computer {
                    id: TIANXU.into(),
                    name: "tianxu".into(),
                    state: ComputerState::Offline,
                    message: Some("Last seen 2 hours ago".into()),
                },
                Computer { id: DEER.into(), name: "deer".into(), state: ComputerState::Online, message: None },
            ],
        };
        // An offline computer's runs can't be read.
        runs.remove(TIANXU);
        let key_of = |ix: usize| scopes[specs[ix].scope].scope().chat_key(ids[ix]);
        let open_families = vec![key_of(open)];
        let shown = specs.iter().position(|spec| spec.title == "Fix Linux onboarding intro hang").expect("the Chat on screen");
        let open_chat = key_of(shown);
        Self { computers, scopes, runs, usage: usage(), open_families, open_chat, current: ADE }
    }

    pub fn scope_at(&self, scope: &ScopeKey) -> Option<&FixtureScope> {
        self.scopes.iter().find(|fixture| fixture.scope() == *scope)
    }

    fn project_on(&self, computer: &str, path: &str) -> Option<&FixtureScope> {
        self.scopes.iter().find(|fixture| fixture.project.computer.as_ref() == computer && fixture.project.path.as_ref() == path)
    }

    /// `project:recent` on `computer`, with its Chats home last.
    pub fn recent(&self, computer: &str) -> Vec<Project> {
        self.scopes.iter().filter(|fixture| fixture.project.computer.as_ref() == computer).map(|fixture| fixture.project.clone()).collect()
    }

    fn open(&self, fixture: &FixtureScope, with_state: bool) -> OpenProject {
        OpenProject { project: fixture.project.clone(), state: with_state.then(|| fixture.state.clone()), stamp: stamp() }
    }

    /// Every message of one Chat, oldest first: alternating user and assistant, as many as its summary counts,
    /// with a tool step on the first reply, the Routine's divider on a Run Chat's first message, and the last
    /// reply ending as the summary says.
    pub fn messages(&self, scope: &ScopeKey, chat: ChatId) -> Option<Vec<ChatMessage>> {
        let session = self.scope_at(scope)?.state.chat(chat)?;
        let summary = session.summary.as_ref()?;
        let mut messages = alternating(chat, summary.count);
        if let (Some(routine), Some(first)) = (&session.routine, messages.first_mut()) {
            first.context = Some(ChatContext::RoutineRun {
                routine_id: routine.routine_id.clone(),
                run_id: routine.run_id.clone(),
                name: "Nightly dependency check".into(),
                at: summary.first_at.unwrap_or(NOW),
                label: Some("Routine · Nightly dependency check".into()),
                quiet: false,
            });
        }
        if let Some(last) = messages.iter_mut().rev().find(|message| message.role == Role::Assistant) {
            last.outcome = summary.last_outcome;
        }
        Some(messages)
    }
}

/// Whether a spec is a row of the All Chats list: listed (it has a message; a hidden Run only while it waits),
/// not archived, not Done, not in a hidden Project, and top-level or in the opened family.
fn shown_in_list(specs: &[Spec], spec: &Spec, open: usize) -> bool {
    let waiting = matches!(spec.live, Live::Approval(_) | Live::Question(_));
    let listed = spec.count > 0 && !(spec.routine == Some(Some(true)) && !waiting);
    if !listed || spec.archived || spec.done.is_some() || PROJECTS[spec.scope].hidden {
        return false;
    }
    let mut root = spec.parent;
    while let Some(parent) = root.and_then(|ix| specs[ix].parent) {
        root = Some(parent);
    }
    root.is_none_or(|root| root == open)
}

fn new_scope(spec: &ProjectSpec) -> FixtureScope {
    let project = Project {
        path: spec.path.into(),
        name: spec.name.into(),
        git: spec.git,
        kind: spec.kind,
        hidden: spec.hidden,
        origin: spec.origin.map(Into::into),
        opened_at: Some("2026-11-11T09:00:00.000Z".into()),
        computer: spec.computer.into(),
        tile: spec.tile,
    };
    // Worktree 1 is the Project folder itself.
    let main = Worktree { base: None, ..Worktree::new(1, 1, spec.path, "main") };
    let state = ScopeState {
        messages_in_chats: true,
        next_id: 0,
        worktrees: BTreeMap::from([(1, main)]),
        sessions: BTreeMap::new(),
        persistence: None,
    };
    FixtureScope { project, state, pull_requests: PullRequestSnapshot::default() }
}

fn slug(title: &str) -> String {
    let words: Vec<String> =
        title.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty()).take(4).map(str::to_ascii_lowercase).collect();
    if words.is_empty() { "chat".to_owned() } else { words.join("-") }
}

/// A Chat's own Worktree, as Milagre creates one per Chat: `milagre/<slug>` off `main`, with a diff. A plain
/// folder's Chats work in the folder itself.
fn worktree_for(project: &Project, id: ChatId, title: &str) -> Worktree {
    let name = slug(title);
    let worktree_id = id + 1;
    let mut worktree = Worktree::new(
        worktree_id,
        1,
        format!("/fixture/worktrees/{}/{name}-{id}", project.name),
        if project.git { format!("milagre/{name}") } else { project.name.to_string() },
    );
    worktree.base = project.git.then(|| "main".into());
    worktree.generated_branch = project.git.then(|| format!("milagre/{name}").into());
    worktree.diff = (project.git && !project.is_chats_home()).then(|| DiffStat { added: id * 37 % 900, removed: id * 11 % 300 });
    worktree
}

fn chat_for(spec: &Spec, id: ChatId, parent: Option<ChatId>, worktree: &Worktree) -> Chat {
    let first_at = NOW - spec.created * MINUTE;
    let mut chat = Chat::new(id, worktree.id, "main");
    chat.status = if spec.live == Live::Idle { SessionStatus::Stopped } else { SessionStatus::Running };
    chat.provider_id = Some(spec.provider.id().into());
    chat.native_session_id = Some(format!("native-{id}").into());
    if spec.count > 0 {
        chat.summary = Some(ChatSummary {
            count: spec.count,
            first_id: Some(id * 1000),
            last_id: Some(id * 1000 + spec.count as u64 - 1),
            first_at: Some(first_at),
            last_at: Some(first_at + (spec.created / 2).min(30) * MINUTE),
            title_line: Some(spec.title.clone().into()),
            last_outcome: spec.outcome,
            pull_requests: spec.prs.iter().map(|number| pull_request_url(&PROJECTS[spec.scope], *number).into()).collect(),
            last_model: Some(model_of(spec.provider).into()),
            ..ChatSummary::default()
        });
    }
    chat.unread = spec.unread;
    chat.archived = spec.archived;
    chat.pinned = spec.pin.is_some();
    chat.pin_order = spec.pin;
    chat.done_at = spec.done.map(|ago| NOW - ago * MINUTE);
    chat.parent = parent;
    chat.routine =
        spec.routine.map(|hidden| RoutineRef { routine_id: "routine-nightly-deps".into(), run_id: format!("run-{id}").into(), hidden });
    chat.permission_mode = Some(PermissionMode::Ask);
    chat.context_usage = (spec.count > 0).then_some(ContextUsage { used: 18_000.0 + id as f64 * 900.0, size: 200_000.0 });
    chat.subagents = (0..spec.background)
        .map(|i| Subagent {
            id: format!("agent-{id}-{i}").into(),
            background: true,
            title: ["Watch the relay logs", "Replay the burst"][i % 2].into(),
            status: SubagentStatus::Running,
            started_at: first_at + (i as i64 + 1) * MINUTE,
            updated_at: NOW,
            ..Subagent::default()
        })
        .collect();
    chat.background_tasks = spec
        .commands
        .iter()
        .enumerate()
        .map(|(i, command)| BackgroundTask {
            id: format!("task-{id}-{i}").into(),
            kind: "local_bash".into(),
            title: (*command).into(),
            started_at: first_at + MINUTE,
        })
        .collect();
    chat
}

fn model_of(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude-opus-5-5",
        Provider::Codex => "gpt-5.5-codex",
        Provider::Antigravity => "gemini-3-pro",
        Provider::Kiro => "kiro-auto",
    }
}

fn run_for(spec: &Spec) -> AgentRun {
    let mut run = AgentRun {
        turn_id: Some("turn-1".into()),
        text: "Reading the sidebar and the shared list rules first.".into(),
        model: model_of(spec.provider).into(),
        permission_mode: Some(PermissionMode::Ask),
        started_at: Some(NOW - 2 * MINUTE),
        ..AgentRun::default()
    };
    match spec.live {
        Live::Approval(command) => run.approvals.push(PermissionRequest {
            request_id: "approval-1".into(),
            kind: PermissionKind::Command,
            tool: "Bash".into(),
            title: format!("Run {command}").into(),
            command: Some(command.into()),
            cwd: Some("/fixture".into()),
            allow_for_chat: true,
            ..PermissionRequest::default()
        }),
        Live::Question(question) => run.questions.push(QuestionRequest {
            request_id: "question-1".into(),
            questions: vec![AgentQuestion {
                id: "q1".into(),
                header: "Approach".into(),
                question: question.into(),
                options: vec![
                    QuestionOption { label: "Yes".into(), description: Some("Go ahead as proposed.".into()) },
                    QuestionOption { label: "No".into(), description: None },
                ],
                multi_select: false,
                allow_other: true,
                secret: false,
            }],
            ..QuestionRequest::default()
        }),
        Live::Working | Live::Idle => {}
    }
    run
}

fn pull_request_url(project: &ProjectSpec, number: u32) -> String {
    let origin = project.origin.map_or_else(|| format!("github.com/victor/{}", project.name), str::to_owned);
    format!("https://{origin}/pull/{number}")
}

/// A PR in the state its number gives it: the named ones as the screen needs them, the rest by number.
fn pull_request(project: &Project, number: u32) -> PullRequest {
    let spec = PROJECTS.iter().find(|spec| spec.path == project.path.as_ref()).expect("a fixture Project");
    let mut pr = PullRequest {
        number: Some(number),
        title: format!("Pull request {number}"),
        url: pull_request_url(spec, number),
        state: PrState::Open,
        conflict_status_known: Some(true),
        ..PullRequest::default()
    };
    match number {
        1015 => pr.checks = Some(Checks::Failed),
        1014 | 1016 | 1010 | 1013 => pr.state = PrState::Merged,
        1020 => pr.checks = Some(Checks::Running),
        1022 => pr.ready_to_merge = true,
        1005 => pr.has_conflicts = true,
        _ => match number % 4 {
            0 => pr.ready_to_merge = true,
            1 => pr.state = PrState::Merged,
            2 => pr.state = PrState::Closed,
            _ => pr.is_draft = true,
        },
    }
    pr
}

fn stamp() -> StateStamp {
    StateStamp { version: Some(1), epoch: Some(EPOCH.into()) }
}

/// One Chat's messages, oldest first: user and assistant in turn, ids `chat * 1000 + i`.
pub fn alternating(chat: ChatId, count: usize) -> Vec<ChatMessage> {
    const ASKS: [&str; 4] = [
        "Why does the sidebar jump when a Chat finishes?",
        "Run the unit tests and fix whatever fails.",
        "Make the approval buttons 28px like DESIGN.md says.",
        "Ship it.",
    ];
    const REPLIES: [&str; 4] = [
        "Done. The draft is now stored per Chat in `drafts.ts`.",
        "All **412** unit tests pass.",
        "The row height changes when the running ring is replaced by the unread dot. I made both 8px.",
        "Renamed. The old key is read once on startup and migrated, then removed.",
    ];
    (0..count)
        .map(|i| {
            let user = i % 2 == 0;
            let id = chat * 1000 + i as u64;
            if user {
                return ChatMessage::text(id, chat, Role::User, ASKS[i / 2 % ASKS.len()]);
            }
            let mut reply = ChatMessage::text(id, chat, Role::Assistant, REPLIES[i / 2 % REPLIES.len()]);
            reply.outcome = Some(Outcome::Completed);
            reply.model = Some("claude-opus-5-5".into());
            if i == 1 {
                reply.steps.push(ChatStep {
                    id: format!("step-{id}").into(),
                    kind: Some(StepKind::Shell),
                    title: "Ran `cargo test`".into(),
                    status: StepStatus::Done,
                    detail: Some("test result: ok. 412 passed".into()),
                    duration_ms: Some(3_600),
                    offset: Some(0),
                    ..ChatStep::default()
                });
            }
            reply
        })
        .collect()
}

/// `chatPage` (`packages/core/src/chat-pages.cjs`): the newest `turns` user turns before `before`, at most
/// `limit` messages.
pub fn chat_page(messages: Vec<ChatMessage>, page: PageRequest) -> MessagePage {
    let total = messages.len();
    let end = page.before.and_then(|before| messages.iter().position(|m| m.id == before)).unwrap_or(total);
    let (mut start, mut seen) = (end, 0);
    while start > 0 && end - start < page.limit {
        start -= 1;
        if messages[start].role == Role::User {
            seen += 1;
            if seen >= page.turns {
                break;
            }
        }
    }
    MessagePage { has_more: start > 0, total, messages: messages[start..end].to_vec() }
}

fn window(id: &str, label: &str, short: &str, used: f64, resets_in_hours: Option<i64>) -> WindowUsage {
    WindowUsage {
        id: id.to_owned(),
        label: label.to_owned(),
        short_label: short.to_owned(),
        used_percent: used,
        resets_at: resets_in_hours.map(|hours| iso(NOW + hours * 60 * MINUTE)),
        detail: None,
    }
}

/// An ISO time for a fixture clock reading (whole minutes on 2026-11-11 and the days after).
fn iso(at: Millis) -> String {
    crate::logic::usage::time::format_iso(at)
}

/// This Mac's usage: Claude's read failed (last-known numbers and why), Codex past the warning line, Antigravity's
/// week past the critical line, Kiro with no numbers (left out of the sidebar).
fn usage() -> UsageSnapshot {
    let updated = iso(NOW - 4 * MINUTE);
    let provider =
        |provider: Provider, status: UsageStatus, windows: Vec<WindowUsage>, message: Option<&str>, banked: Option<u32>| ProviderUsage {
            usage: AccountUsage {
                account: Some(AccountRef { id: format!("{}-default", provider.id()), label: "Personal".into(), email: None }),
                provider,
                status,
                windows,
                updated_at: updated.clone(),
                banked_resets: banked,
            },
            checked_at: Some(iso(NOW - MINUTE).into()),
            message: message.map(Into::into),
        };
    UsageSnapshot {
        account_key: Some("default".into()),
        generated_at: Some(iso(NOW).into()),
        providers: vec![
            provider(
                Provider::Claude,
                UsageStatus::Error,
                vec![window("five_hour", "5-hour", "5h", 2.0, Some(3)), window("seven_day", "Weekly", "wk", 3.0, Some(96))],
                Some("Couldn't read usage: the Claude Code sign-in expired."),
                None,
            ),
            provider(Provider::Codex, UsageStatus::Ok, vec![window("weekly", "Weekly", "wk", 86.0, Some(50))], None, Some(1)),
            provider(
                Provider::Antigravity,
                UsageStatus::Ok,
                vec![window("five_hour", "5-hour", "5h", 0.0, Some(5)), window("weekly", "Weekly", "wk", 97.0, Some(30))],
                None,
                None,
            ),
            provider(Provider::Kiro, UsageStatus::Unavailable, Vec::new(), Some("Kiro CLI is not signed in."), None),
        ],
    }
}

/// [`FixtureData`] behind the [`DataSource`] calls; every answer is ready at once.
#[derive(Clone, Default)]
pub struct FixtureSource {
    data: Arc<FixtureData>,
    /// The fixture switch for a Mac with no Project yet: `project:current` answers `None` and onboarding shows.
    no_project: bool,
}

impl FixtureSource {
    pub fn new() -> Self {
        Self { data: Arc::new(FixtureData::new()), no_project: false }
    }

    /// The fixture of a first launch: the same data, but no current Project, so the window opens on onboarding.
    pub fn without_project() -> Self {
        Self { data: Arc::new(FixtureData::new()), no_project: true }
    }

    pub fn data(&self) -> &FixtureData {
        &self.data
    }

    fn reachable(&self, computer: &str) -> anyhow::Result<()> {
        if computer == LOCAL || self.data.computers.computers.iter().any(|known| known.id.as_ref() == computer) {
            Ok(())
        } else {
            Err(anyhow!("No paired computer has the id {computer}."))
        }
    }
}

impl DataSource for FixtureSource {
    fn computers(&self) -> DataFuture<ComputersSnapshot> {
        ready(Ok(self.data.computers.clone()))
    }

    fn recent_projects(&self, computer: ComputerId) -> DataFuture<Vec<Project>> {
        ready(self.reachable(&computer).map(|()| self.data.recent(&computer)))
    }

    fn current_project(&self) -> DataFuture<Option<OpenProject>> {
        ready(Ok((!self.no_project).then(|| self.data.open(&self.data.scopes[self.data.current], true))))
    }

    fn open_project(&self, computer: ComputerId, folder: SharedString) -> DataFuture<OpenProject> {
        let found = self.data.project_on(&computer, &folder).map(|fixture| self.data.open(fixture, true));
        ready(found.ok_or_else(|| anyhow!("{folder} is not a fixture Project.")))
    }

    fn read_project(&self, computer: ComputerId, path: SharedString, with_state: bool) -> DataFuture<OpenProject> {
        let found = self.data.project_on(&computer, &path).map(|fixture| self.data.open(fixture, with_state));
        ready(found.ok_or_else(|| anyhow!("Open this project in Milagre first.")))
    }

    fn read_state(&self, scope: ScopeKey) -> DataFuture<StateRead> {
        let found = self.data.scope_at(&scope).map(|fixture| StateRead { state: fixture.state.clone(), stamp: stamp() });
        ready(found.ok_or_else(|| anyhow!("Open the Project before reading its state.")))
    }

    fn chat_runs(&self, computer: ComputerId) -> DataFuture<ChatRuns> {
        if let Err(error) = self.reachable(&computer) {
            return ready(Err(error));
        }
        let result = match self.data.runs.get(&computer) {
            Some(runs) => Ok(runs.clone()),
            None if self.data.computers.is_offline(&computer) => Err(anyhow!("{} is offline.", self.data.computers.name_of(&computer))),
            None => Ok(ChatRuns::default()),
        };
        ready(result)
    }

    fn chat_messages(&self, scope: ScopeKey, chat: ChatId, page: PageRequest) -> DataFuture<MessagePage> {
        let result = match self.data.scope_at(&scope) {
            None => Err(anyhow!("Open the Project before reading its messages.")),
            Some(_) => match self.data.messages(&scope, chat) {
                Some(messages) => Ok(chat_page(messages, page)),
                None => Err(anyhow!("That Chat is no longer in this Project.")),
            },
        };
        ready(result)
    }

    fn pull_requests(&self, scope: ScopeKey) -> DataFuture<PullRequestSnapshot> {
        ready(Ok(self.data.scope_at(&scope).map(|fixture| fixture.pull_requests.clone()).unwrap_or_default()))
    }

    fn cached_usage(&self, computer: ComputerId) -> DataFuture<UsageSnapshot> {
        ready(Ok(if computer.as_ref() == LOCAL { self.data.usage.clone() } else { UsageSnapshot::default() }))
    }
}

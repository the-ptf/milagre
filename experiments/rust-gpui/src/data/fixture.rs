//! The fixture backend: five Projects and the Chats home, 500 deterministic Chats across them, their
//! runs, their messages and the usage block. [`FixtureSource`] serves it through [`DataSource`] the way the
//! daemon would; views that are not wired to a source yet read [`FixtureData`] directly.
//!
//! The first eight Chats are the screen the spike is judged on; the rest come from small tables and a
//! fixed LCG, so every run and test sees the same list.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::anyhow;
use gpui::{Rgba, SharedString};

use super::source::ready;
use super::{
    Chat, ChatId, ChatRuns, ChatStatus, DataFuture, DataSource, Message, MessagePage, Outcome, PageRequest, Project, ProjectKind,
    ProjectSnapshot, Provider, ProviderUsage, Role, RunState, ScopeKey, ScopeState, UsageStatus, UsageWindow, Worktree,
};
use crate::theme::hex;

pub const CHAT_COUNT: usize = 500;
const ROOT: &str = "/fixture";

/// Name and tile colour of each fixture Project; the Chats home comes last.
const PROJECTS: [(&str, Option<Rgba>); 5] = [
    ("milagre-ade", None),
    ("happiergym", Some(hex("#1f9d6b"))),
    ("milagre", Some(hex("#2b4fd6"))),
    ("rd-car", Some(hex("#5b46d6"))),
    ("site", None),
];
const MILAGRE_ADE: usize = 0;
const MILAGRE: usize = 2;
const RD_CAR: usize = 3;
const CHATS_HOME: usize = PROJECTS.len();

/// One Chat in the list with what the list needs beside it.
#[derive(Clone, Debug)]
pub struct ListedChat {
    pub project: usize,
    pub chat: Chat,
    pub run: Option<RunState>,
}

impl ListedChat {
    pub fn status(&self) -> ChatStatus {
        ChatStatus::of(&self.chat, self.run)
    }
}

/// Everything the fixture knows, built once.
pub struct FixtureData {
    pub projects: Vec<Project>,
    /// One Worktree per Project (its main checkout), by Project index.
    pub worktrees: Vec<Worktree>,
    /// The All Chats list, in order.
    pub chats: Vec<ListedChat>,
}

impl Default for FixtureData {
    fn default() -> Self {
        Self::new()
    }
}

impl FixtureData {
    pub fn new() -> Self {
        let mut projects: Vec<Project> = PROJECTS
            .iter()
            .map(|&(name, color)| Project {
                path: Path::new(ROOT).join(name),
                name: name.into(),
                kind: ProjectKind::Project,
                git: true,
                color,
            })
            .collect();
        projects.push(Project {
            path: Path::new(ROOT).join("chats"),
            name: "Chats".into(),
            kind: ProjectKind::ChatsHome,
            git: false,
            color: None,
        });
        let worktrees = projects
            .iter()
            .enumerate()
            .map(|(ix, project)| Worktree { id: ix as u64 * 100 + 1, path: project.path.clone(), name: "main".into(), base: None })
            .collect();
        let mut data = Self { projects, worktrees, chats: Vec::with_capacity(CHAT_COUNT) };
        data.generate();
        data
    }

    fn push(&mut self, project: usize, title: &str, pull_requests: Vec<u32>, computer: &str, status: ChatStatus) {
        let id = self.chats.len() as ChatId + 1;
        let run = match status {
            ChatStatus::Running => Some(RunState::Running),
            ChatStatus::NeedsApproval => Some(RunState::WaitingApproval),
            ChatStatus::Question => Some(RunState::WaitingAnswer),
            _ => None,
        };
        let chat = Chat {
            id,
            worktree: self.worktrees[project].id,
            title: title.to_string().into(),
            provider: if id.is_multiple_of(5) { Provider::Codex } else { Provider::Claude },
            unread: status == ChatStatus::Unread,
            archived: false,
            pinned: false,
            last_outcome: (status == ChatStatus::Failed).then_some(Outcome::Failed),
            pull_requests,
            computer: computer.to_string().into(),
        };
        self.chats.push(ListedChat { project, chat, run });
    }

    fn generate(&mut self) {
        use ChatStatus::{Failed, NeedsApproval, Question, Running, Unread};
        self.push(MILAGRE_ADE, "Migrate desktop to Rust PoC", vec![], "Victor XPro", Running);
        self.push(MILAGRE_ADE, "Fix Linux onboarding intro hang", vec![1020], "Victor XPro", NeedsApproval);
        self.push(MILAGRE, "Fix Windows port listener cleanup", vec![], "tianxu", Unread);
        self.push(MILAGRE_ADE, "Codebase analysis and fixes", vec![1015, 1014, 1016, 1020], "Victor XPro", Running);
        self.push(RD_CAR, "RDCar ops", vec![], "deer", Question);
        self.push(CHATS_HOME, "Gestor RDCar", vec![], "deer", Unread);
        self.push(MILAGRE_ADE, "Identify issues to close", vec![], "Victor XPro", ChatStatus::None);
        self.push(MILAGRE_ADE, "Rust terminal owner migration", vec![], "Victor XPro", Failed);

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
        const WHO: [&str; 4] = ["Victor XPro", "tianxu", "deer", "Santo"];
        // The same draws in the same order as the spike's first fixture, so the list did not change.
        let mut seed: u32 = 0x9e37_79b9;
        let mut next = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as usize
        };
        while self.chats.len() < CHAT_COUNT {
            let n = self.chats.len();
            let project = next() % PROJECTS.len();
            let topic = TOPICS[next() % TOPICS.len()];
            let who = WHO[next() % WHO.len()];
            let status = match next() % 12 {
                0 => Running,
                1 => NeedsApproval,
                2 => Question,
                3 => Failed,
                4 | 5 => Unread,
                _ => ChatStatus::None,
            };
            let pull_requests = if next() % 3 == 0 { vec![900 + (next() % 200) as u32] } else { vec![] };
            self.push(project, &format!("{topic} {n}"), pull_requests, who, status);
        }
    }

    pub fn project_at(&self, path: &Path) -> Option<usize> {
        self.projects.iter().position(|project| project.path == path)
    }

    fn scope_index(&self, scope: &ScopeKey) -> anyhow::Result<usize> {
        self.project_at(Path::new(scope.0.as_ref())).ok_or_else(|| anyhow!("Open the Project before reading its messages."))
    }

    pub fn state(&self, project: usize) -> ScopeState {
        ScopeState {
            worktrees: vec![self.worktrees[project].clone()],
            chats: self.chats.iter().filter(|listed| listed.project == project).map(|listed| listed.chat.clone()).collect(),
        }
    }

    fn snapshot(&self, project: usize, with_state: bool) -> ProjectSnapshot {
        ProjectSnapshot { project: self.projects[project].clone(), state: with_state.then(|| self.state(project)) }
    }

    pub fn runs(&self) -> ChatRuns {
        let runs =
            self.chats.iter().filter_map(|listed| Some(((self.projects[listed.project].scope(), listed.chat.id), listed.run?))).collect();
        ChatRuns { runs, seq: 1 }
    }

    /// Every message of one Chat, oldest first: alternating user and assistant, 4 to 40 of them.
    pub fn messages(&self, chat: ChatId) -> Vec<Message> {
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
        let count = 4 + (chat as usize * 7) % 37;
        (0..count)
            .map(|i| {
                let user = i % 2 == 0;
                Message {
                    id: chat * 1000 + i as u64,
                    chat,
                    role: if user { Role::User } else { Role::Assistant },
                    body: SharedString::from(if user { ASKS[i / 2 % ASKS.len()] } else { REPLIES[i / 2 % REPLIES.len()] }),
                    outcome: (!user).then_some(Outcome::Completed),
                }
            })
            .collect()
    }
}

/// `chatPage` (`packages/core/src/chat-pages.cjs`): the newest `turns` user turns before `before`, at most
/// `limit` messages.
pub fn chat_page(messages: Vec<Message>, page: PageRequest) -> MessagePage {
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

/// The usage block's numbers.
pub fn usage() -> Vec<ProviderUsage> {
    let window = |short: &str, used: f32| UsageWindow { short_label: short.to_string().into(), used_percent: used };
    vec![
        ProviderUsage { provider: Provider::Claude, status: UsageStatus::Error, windows: vec![window("wk", 2.0), window("wk", 3.0)] },
        ProviderUsage { provider: Provider::Codex, status: UsageStatus::Ok, windows: vec![window("wk", 46.0)] },
        ProviderUsage { provider: Provider::Antigravity, status: UsageStatus::Ok, windows: vec![window("5h", 0.0), window("wk", 0.0)] },
    ]
}

/// [`FixtureData`] behind the [`DataSource`] calls; every answer is ready at once.
#[derive(Clone, Default)]
pub struct FixtureSource {
    data: Arc<FixtureData>,
}

impl FixtureSource {
    pub fn new() -> Self {
        Self { data: Arc::new(FixtureData::new()) }
    }

    pub fn data(&self) -> &FixtureData {
        &self.data
    }
}

impl DataSource for FixtureSource {
    fn current_project(&self) -> DataFuture<Option<ProjectSnapshot>> {
        ready(Ok(Some(self.data.snapshot(MILAGRE_ADE, true))))
    }

    fn open_project(&self, folder: PathBuf) -> DataFuture<ProjectSnapshot> {
        let found = self.data.project_at(&folder).map(|ix| self.data.snapshot(ix, true));
        ready(found.ok_or_else(|| anyhow!("{} is not a fixture Project.", folder.display())))
    }

    fn read_state(&self, scope: ScopeKey) -> DataFuture<ScopeState> {
        ready(self.data.scope_index(&scope).map(|ix| self.data.state(ix)))
    }

    fn read_project(&self, path: PathBuf, with_state: bool) -> DataFuture<ProjectSnapshot> {
        let found = self.data.project_at(&path).map(|ix| self.data.snapshot(ix, with_state));
        ready(found.ok_or_else(|| anyhow!("Open this project in Milagre first.")))
    }

    fn chat_runs(&self) -> DataFuture<ChatRuns> {
        ready(Ok(self.data.runs()))
    }

    fn chat_messages(&self, scope: ScopeKey, chat: ChatId, page: PageRequest) -> DataFuture<MessagePage> {
        let result = self.data.scope_index(&scope).and_then(|ix| {
            let known = self.data.chats.iter().any(|listed| listed.project == ix && listed.chat.id == chat);
            if known { Ok(chat_page(self.data.messages(chat), page)) } else { Err(anyhow!("That Chat is no longer in this Project.")) }
        });
        ready(result)
    }
}

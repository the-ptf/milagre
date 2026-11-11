//! The All Chats list built from domain data through the shared rules: a port of `scopeChats`, `mergeScopeChats`
//! and `runKeys` (`apps/desktop/app/src/lib/sidebar-scopes.ts`) and `shownChats` (`lib/subchat-rows.ts`), on top of
//! `logic::lists` (listing, pins, order, Done, Subchat families) and `logic::marks` (the mark and its activity).
//!
//! What the desktop's one-list sidebar shows, in this order: every scope's pinned Chats (Chats homes first), then
//! the "All Chats" list (every scope's unpinned Chats merged by the Chat order setting, Subchats under their
//! family's top Chat, folded unless this device opened the family), then the Done section (most recently marked
//! first). Hidden Projects are left out; an offline computer's scopes show from their last state, without runs.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use gpui::{Global, SharedString};

use crate::data::{
    Chat, ChatRuns, ComputerId, ComputersSnapshot, DataFuture, DataSource, LOCAL, Millis, Outcome, Project, PullRequestSnapshot,
    ScopeState, UsageSnapshot,
};
use crate::logic::lists::order::{ChatOrder, order_chats};
use crate::logic::lists::pins::{DevicePins, sessions_with_pins};
use crate::logic::lists::subchats::nest_subchats;
use crate::logic::marks::activity::Activity;
use crate::logic::marks::{ChatMark, MarkInput, chat_mark};

/// What this device keeps for the sidebar that is not daemon data: the Subchat families it opened (the desktop's
/// `milagre.subchatsOpen`, by the parent's Chat key) and the Chat the window shows. A preference store will hold
/// these; until then the app seeds them (from the fixture).
#[derive(Clone, Debug, Default)]
pub struct SidebarSeed {
    pub open_families: HashSet<String>,
    pub open_chat: Option<String>,
}

impl Global for SidebarSeed {}

/// One scope the sidebar lists: its Project (or Chats home), its state and its PRs.
#[derive(Clone, Debug)]
pub struct ScopeData {
    pub project: Project,
    pub state: ScopeState,
    pub pull_requests: PullRequestSnapshot,
}

/// Everything the sidebar reads through the [`DataSource`].
#[derive(Clone, Debug, Default)]
pub struct SidebarData {
    pub computers: ComputersSnapshot,
    /// Every scope, hidden Projects included (the lists leave them out), each computer's in its recent order.
    pub scopes: Vec<ScopeData>,
    /// Every reachable computer's runs, by qualified Chat key.
    pub runs: ChatRuns,
    /// This Mac's cached plan usage.
    pub usage: UsageSnapshot,
}

impl SidebarData {
    /// Reads the computers, each computer's recent Projects, each visible scope's state and PRs, each computer's
    /// runs (a computer that does not answer has none) and this Mac's usage. A scope whose state can't be read is
    /// left out.
    pub fn load(source: Arc<dyn DataSource>) -> DataFuture<SidebarData> {
        Box::pin(async move {
            let computers = source.computers().await?;
            let mut scopes = Vec::new();
            let mut runs = Vec::new();
            for computer in computers.ids() {
                let recent = source.recent_projects(computer.clone()).await.unwrap_or_default();
                // Hidden Projects load too: Filters can bring one back, and the lists leave them out.
                for project in recent {
                    let Ok(read) = source.read_state(project.scope()).await else { continue };
                    let pull_requests = source.pull_requests(project.scope()).await.unwrap_or_default();
                    scopes.push(ScopeData { project, state: read.state, pull_requests });
                }
                if let Ok(computer_runs) = source.chat_runs(computer).await {
                    runs.push(computer_runs);
                }
            }
            let usage = source.cached_usage(ComputerId::from(LOCAL)).await.unwrap_or_default();
            Ok(SidebarData { computers, scopes, runs: ChatRuns::merge(runs), usage })
        })
    }
}

/// One Chat as a scope lists it (`SidebarRecent`): the Chat, where it lives and its mark.
#[derive(Clone, Debug)]
pub struct ListedChat {
    /// Index into [`SidebarData::scopes`].
    pub scope: usize,
    /// `<scope>#<id>`.
    pub key: String,
    /// The parent's key, for a Subchat.
    pub parent: Option<String>,
    pub chat: Chat,
    pub mark: ChatMark,
    /// The last turn failed (an idle row then shows the failed dot).
    pub failed: bool,
    /// Background work still going, while the mark is Background.
    pub background: usize,
    pub first_at: Option<Millis>,
    pub last_at: Option<Millis>,
}

/// `runKeys`: which Chats run, wait on an approval or question, or ask (a question and no approval).
struct RunMarks<'a>(&'a ChatRuns);

impl RunMarks<'_> {
    fn running(&self, key: &str) -> bool {
        self.0.get(key).is_some()
    }

    fn waiting(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(|run| run.waiting())
    }

    fn asking(&self, key: &str) -> bool {
        self.0.get(key).is_some_and(|run| run.approvals.is_empty() && !run.questions.is_empty())
    }
}

/// `scopeChats`: a scope's listed Chats (this device's pins in place, archived ones and empty starters out, a
/// hidden Run Chat only while it waits) in the Chat order, each with its mark.
fn scope_chats(scope: usize, data: &ScopeData, order: ChatOrder, marks: &RunMarks, pins: &DevicePins) -> Vec<ListedChat> {
    let key = data.project.scope();
    let pinned = sessions_with_pins(&data.state.sessions, key.as_str(), pins);
    let sessions = pinned.as_ref().unwrap_or(&data.state.sessions);
    let listed: Vec<&Chat> = sessions
        .values()
        .filter(|chat| !chat.archived)
        .filter(|chat| {
            let at = key.chat_key(chat.id);
            chat.is_listed(marks.waiting(&at) || marks.asking(&at))
        })
        .collect();
    order_chats(&listed, order, |chat| chat.sort_key())
        .into_iter()
        .map(|chat| {
            let at = key.chat_key(chat.id);
            let running = marks.running(&at);
            // A Chat with no run here can still have background agents at work; its last outcome decides first.
            let activity = chat.activity(None);
            let in_background = !running && activity.activity == Activity::Background;
            let mark = chat_mark(MarkInput {
                asking: marks.asking(&at),
                waiting: marks.waiting(&at),
                running,
                background: in_background,
                unread: chat.unread,
                ..MarkInput::default()
            });
            let summary = chat.summary.as_ref();
            ListedChat {
                scope,
                parent: chat.parent.map(|parent| key.chat_key(parent)),
                key: at,
                chat: chat.clone(),
                mark,
                failed: chat.last_outcome() == Some(Outcome::Failed),
                background: if in_background { activity.background } else { 0 },
                first_at: summary.and_then(|summary| summary.first_at),
                last_at: summary.and_then(|summary| summary.last_at),
            }
        })
        .collect()
}

/// `mergeScopeChats`: every scope's rows as one list. Pinned first by pin order, then the rest by the Chat order
/// (created: by the first message's time, else the latest; recent: by the latest), each scope keeping its own order
/// and the scopes interleaving by the row each has next. Ties go to the earlier scope.
fn merge_scope_chats(scopes: &[Vec<ListedChat>], order: ChatOrder) -> Vec<ListedChat> {
    let time_of = |row: &ListedChat| match order {
        ChatOrder::Created => row.first_at.or(row.last_at),
        ChatOrder::Recent => row.last_at,
    };
    let mut merged = Vec::new();
    for pinned in [true, false] {
        let queues: Vec<Vec<&ListedChat>> =
            scopes.iter().map(|rows| rows.iter().filter(|row| row.chat.pinned == pinned).collect()).collect();
        let mut at = vec![0; queues.len()];
        // `a` goes before `b`: the lower pin order, else the newer time.
        let before = |a: &ListedChat, b: &ListedChat| {
            if pinned {
                a.chat.pin_order.unwrap_or(0.0) < b.chat.pin_order.unwrap_or(0.0)
            } else {
                time_of(a).unwrap_or(0) > time_of(b).unwrap_or(0)
            }
        };
        loop {
            let mut best: Option<usize> = None;
            for (ix, queue) in queues.iter().enumerate() {
                let Some(row) = queue.get(at[ix]) else { continue };
                if best.is_none_or(|best| before(row, queues[best][at[best]])) {
                    best = Some(ix);
                }
            }
            let Some(ix) = best else { break };
            merged.push(queues[ix][at[ix]].clone());
            at[ix] += 1;
        }
    }
    merged
}

/// A family's count on its parent's row (`ShownRow.family`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Family {
    pub count: usize,
    pub folded: bool,
    /// A Subchat in it waits on the user.
    pub asking: bool,
}

/// A row as the list shows it: the Chat, how deep it sits (0 top-level, 1 or 2 a Subchat) and, on a family's
/// parent, its family.
#[derive(Clone, Debug)]
pub struct ShownChat {
    pub item: ListedChat,
    pub depth: usize,
    pub family: Option<Family>,
}

/// `shownChats`: each Subchat under its topmost listed ancestor; a folded family shows its parent alone.
fn shown_chats(rows: Vec<ListedChat>, opened: &HashSet<String>) -> Vec<ShownChat> {
    if rows.iter().all(|row| row.parent.is_none()) {
        return rows.into_iter().map(|item| ShownChat { item, depth: 0, family: None }).collect();
    }
    let parents: HashMap<String, Option<String>> = rows.iter().map(|row| (row.key.clone(), row.parent.clone())).collect();
    let mut shown = Vec::new();
    for group in nest_subchats(&rows, |row| row.key.clone(), |at| parents.get(at).cloned().flatten()) {
        if group.children.is_empty() {
            shown.push(ShownChat { item: group.row, depth: 0, family: None });
            continue;
        }
        let folded = !opened.contains(&group.row.key);
        let asking = group.children.iter().any(|child| matches!(child.mark, ChatMark::Question | ChatMark::Waiting));
        shown.push(ShownChat { item: group.row, depth: 0, family: Some(Family { count: group.children.len(), folded, asking }) });
        if !folded {
            for (child, depth) in group.children.into_iter().zip(group.depths) {
                shown.push(ShownChat { item: child, depth, family: None });
            }
        }
    }
    shown
}

/// The sidebar's lists.
#[derive(Clone, Debug, Default)]
pub struct ChatLists {
    /// The Pinned section, above All Chats.
    pub pinned: Vec<ShownChat>,
    /// All Chats.
    pub rows: Vec<ShownChat>,
    /// The Done section, most recently marked first.
    pub done: Vec<ListedChat>,
}

/// What this device keeps that shapes the lists: its pins and what Filters leaves out.
#[derive(Clone, Debug, Default)]
pub struct ListFilters {
    /// This device's pins (`milagre.chatPins`); a scope it has not pinned in yet shows the shared ones.
    pub pins: DevicePins,
    /// Computers whose Projects the sidebar leaves out (Filters › Computers).
    pub hidden_computers: HashSet<String>,
}

/// The sidebar's lists from its data: the one-list layout's Pinned, All Chats and Done.
pub fn chat_lists(data: &SidebarData, order: ChatOrder, opened: &HashSet<String>) -> ChatLists {
    chat_lists_with(data, order, opened, &ListFilters::default())
}

/// [`chat_lists`] with this device's pins and filters.
pub fn chat_lists_with(data: &SidebarData, order: ChatOrder, opened: &HashSet<String>, filters: &ListFilters) -> ChatLists {
    let marks = RunMarks(&data.runs);
    let all: Vec<Vec<ListedChat>> = data
        .scopes
        .iter()
        .enumerate()
        .map(|(ix, scope)| {
            if scope.project.hidden || filters.hidden_computers.contains(scope.project.computer.as_ref()) {
                return Vec::new();
            }
            scope_chats(ix, scope, order, &marks, &filters.pins)
        })
        .collect();
    // Chats homes go first, as the desktop passes them to the merge.
    let mut ordered: Vec<&Vec<ListedChat>> = Vec::new();
    ordered.extend(all.iter().filter(|rows| rows.first().is_some_and(|row| data.scopes[row.scope].project.is_chats_home())));
    ordered.extend(all.iter().filter(|rows| rows.first().is_none_or(|row| !data.scopes[row.scope].project.is_chats_home())));
    let mut done: Vec<ListedChat> = ordered.iter().flat_map(|rows| rows.iter().filter(|row| row.chat.is_done()).cloned()).collect();
    done.sort_by(|a, b| crate::logic::lists::done::by_done_at(a.chat.done_at, b.chat.done_at));
    let live: Vec<Vec<ListedChat>> = ordered.iter().map(|rows| rows.iter().filter(|row| !row.chat.is_done()).cloned().collect()).collect();
    let pinned = live.iter().flat_map(|rows| rows.iter().filter(|row| row.chat.pinned).cloned()).collect::<Vec<_>>();
    let rest: Vec<Vec<ListedChat>> = live.iter().map(|rows| rows.iter().filter(|row| !row.chat.pinned).cloned().collect()).collect();
    ChatLists {
        pinned: pinned.into_iter().map(|item| ShownChat { item, depth: 0, family: None }).collect(),
        rows: shown_chats(merge_scope_chats(&rest, order), opened),
        done,
    }
}

/// The name a Chats home's rows show for their Project.
pub fn project_label(project: &Project) -> SharedString {
    if project.is_chats_home() { crate::logic::identity::chats_home::CHATS_GROUP_LABEL.into() } else { project.name.clone() }
}

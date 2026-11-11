//! Routines (WP-45): the Routines list, one Routine's page with its Runs, the Routine form and the Run Chat beside a
//! Routine's page. After `apps/desktop/app/src/components/routines/` (`RoutinesPage`, `RoutineRow`, `RoutinePage`,
//! `RunList`, `RoutineEditor`, `PlaceholderTextarea`, `RunChatHeader`) and `App.tsx`'s Run Chat split.
//!
//! | File | Holds |
//! | --- | --- |
//! | `model.rs`, `fixture.rs` | the Routine, Run and trigger types (`model.ts`) and the fixture `routines:list` answers |
//! | `words.rs` | `routines.mjs` and `lib/routines.ts`: trigger and schedule words, folds, days, filters, row meta and status |
//! | `form.rs` | `routine-form.mjs`: form state, cron round trips, validation, the create input and update patch |
//! | `prompt.rs` | `routine-prompt.mjs`: the `{{` placeholder list and the text helpers behind its autocomplete |
//! | `list.rs` | the list page and its rows (R-01) |
//! | `page.rs` | the Routine page (R-02) and the Run Chat pane's header (V-04) |
//! | `runs.rs` | the Runs list (R-03) |
//! | `editor.rs`, `placeholders.rs` | the Routine form (R-04) and its prompt with the `{{` list (R-05) |
//! | `flows/` | the Flow page a flow Routine opens (WP-46): steps, inspectors, Run view |
//!
//! One [`RoutinesView`] takes the place of the Chat column (the sidebar's Routines button opens it): the list, or the
//! open Routine's page, or the form in place of either. A Run's Chat opens beside the page, which then narrows to a
//! 420px column (V-04). Every action works on the view's own copy of the fixture, as `act` does after `routines:*`
//! answers, so Pause, Run now, Delete, Save and Create change what the page shows.

pub mod fixture;
pub mod flows;
pub mod form;
pub mod model;
pub mod prompt;
pub mod words;

mod editor;
mod list;
mod page;
mod placeholders;
mod runs;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use gpui::{AnyElement, Context, Entity, IntoElement, Render, ScrollHandle, SharedString, Subscription, Window, div, prelude::*};

use crate::data::Millis;
use crate::theme::ActiveTheme;
use crate::ui::IconName;
use crate::workspace::chat::ChatView;
use editor::{EditorEvent, RoutineEditor};
use model::{Routine, Run, RunStatus, Target, Trigger};
use words::RunFilter;

/// What the list's Show menu narrows to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    All,
    Heartbeats,
    Triggers,
    Paused,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::All, Kind::Heartbeats, Kind::Triggers, Kind::Paused];

    pub fn id(self) -> &'static str {
        match self {
            Kind::All => "all",
            Kind::Heartbeats => "heartbeats",
            Kind::Triggers => "triggers",
            Kind::Paused => "paused",
        }
    }

    pub fn from_id(id: &str) -> Kind {
        Kind::ALL.into_iter().find(|kind| kind.id() == id).unwrap_or(Kind::All)
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::All => "All Routines",
            Kind::Heartbeats => "Heartbeats",
            Kind::Triggers => "Triggers",
            Kind::Paused => "Paused",
        }
    }
}

/// What the view opens on when `MILAGRE_GPUI_ROUTINES` names it (snapshots and manual checks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    List,
    Page,
    RunChat,
    EditorNew,
    EditorEdit,
    EditorWebhook,
    Empty,
    /// The Flow page (`flows/`): the Review queue's draft, with a step selected, a Run shown, or another tab.
    Flow(FlowStart),
}

/// Where the Flow page opens (`MILAGRE_GPUI_ROUTINES=flow-…`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowStart {
    /// The draft, Classify selected.
    Draft,
    /// The draft, its If selected.
    If,
    /// The draft, the pull request step selected.
    PullRequest,
    /// The first-step tiles of a flow never published.
    Empty,
    /// Run 14, waiting for you at the pull request.
    Approval,
    /// Run 15, waiting at an approval with a message.
    Ask,
    /// Run 13, stopped at Implement.
    Failed,
    /// Run 12, done, with the pull request's receipt.
    Receipt,
    /// The Runs tab.
    Runs,
    /// The Settings tab.
    Settings,
}

impl Start {
    pub fn parse(name: &str) -> Option<Start> {
        Some(match name {
            "1" | "list" => Start::List,
            "page" => Start::Page,
            "runchat" => Start::RunChat,
            "editor-new" | "editor" => Start::EditorNew,
            "editor-edit" => Start::EditorEdit,
            "editor-webhook" => Start::EditorWebhook,
            "empty" => Start::Empty,
            "flow" => Start::Flow(FlowStart::Draft),
            "flow-if" => Start::Flow(FlowStart::If),
            "flow-pr" => Start::Flow(FlowStart::PullRequest),
            "flow-empty" => Start::Flow(FlowStart::Empty),
            "flow-approval" => Start::Flow(FlowStart::Approval),
            "flow-ask" => Start::Flow(FlowStart::Ask),
            "flow-failed" => Start::Flow(FlowStart::Failed),
            "flow-receipt" => Start::Flow(FlowStart::Receipt),
            "flow-runs" => Start::Flow(FlowStart::Runs),
            "flow-settings" => Start::Flow(FlowStart::Settings),
            _ => return None,
        })
    }
}

/// The page the environment asks the window to open on, if any (`MILAGRE_GPUI_ROUTINES`).
pub fn start_from_env() -> Option<Start> {
    std::env::var("MILAGRE_GPUI_ROUTINES").ok().and_then(|name| Start::parse(&name))
}

/// The Run Chat pane: a Chat column beside the Routine's page.
pub struct RunChat {
    pub key: String,
    pub title: SharedString,
    pub run: Option<Run>,
    pub view: Entity<ChatView>,
}

/// Which form is open: New Routine, or an edit of a Routine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Editing {
    New,
    Routine(String),
}

pub struct RoutinesView {
    pub(crate) routines: Vec<Routine>,
    pub(crate) now: Millis,
    pub(crate) unread_chats: HashSet<String>,
    pub(crate) unread_routines: HashSet<String>,
    pub(crate) kind: Kind,
    /// "all", or one computer's id.
    pub(crate) computer: String,
    /// The row whose delete asks to be confirmed.
    pub(crate) confirming: Option<String>,
    pub(crate) error: Option<SharedString>,
    /// The Routine whose page is open.
    pub(crate) open: Option<String>,
    pub(crate) editing: Option<Editing>,
    pub(crate) editor: Option<Entity<RoutineEditor>>,
    /// A webhook Routine just created: its page shows the URL once.
    pub(crate) created_hook: Option<(String, String)>,
    pub(crate) run_filter: RunFilter,
    pub(crate) shown_days: usize,
    /// Open folds and older days on the Runs list, by key.
    pub(crate) expanded: HashSet<String>,
    pub(crate) run_chat: Option<RunChat>,
    pub(crate) list_scroll: ScrollHandle,
    pub(crate) page_scroll: ScrollHandle,
    /// The open flow Routine's page (`flows/`).
    pub(crate) flow: Option<flows::FlowState>,
    /// Where each flow's page was left.
    pub(crate) flow_last: HashMap<String, flows::LastView>,
    next_id: u32,
    _editor: Option<Subscription>,
}

impl RoutinesView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::with_routines(fixture::routines(), model::fixture_now());
        match start_from_env() {
            Some(Start::Page) => view.open = Some("rt-nightly".into()),
            Some(Start::RunChat) => {
                view.open = Some("rt-nightly".into());
                view.open_run_chat(fixture::NIGHTLY_RUN_CHAT, window, cx);
            }
            Some(Start::EditorNew) => view.start_editor(Some(Editing::New), window, cx),
            Some(Start::EditorEdit) => {
                view.open = Some("rt-nightly".into());
                view.start_editor(Some(Editing::Routine("rt-nightly".into())), window, cx);
            }
            Some(Start::EditorWebhook) => {
                view.open = Some("rt-sentry".into());
                view.start_editor(Some(Editing::Routine("rt-sentry".into())), window, cx);
            }
            Some(Start::Empty) => view.routines.clear(),
            Some(Start::Flow(start)) => view.start_flow(start, cx),
            Some(Start::List) | None => {}
        }
        view
    }

    /// A view over `routines`, read at `now`, with the fixture's unread Run Chats.
    pub fn with_routines(routines: Vec<Routine>, now: Millis) -> Self {
        Self {
            routines,
            now,
            unread_chats: fixture::unread_chats().into_iter().collect(),
            unread_routines: fixture::unread_routines().into_iter().collect(),
            kind: Kind::All,
            computer: "all".into(),
            confirming: None,
            error: None,
            open: None,
            editing: None,
            editor: None,
            created_hook: None,
            run_filter: RunFilter::All,
            shown_days: runs::FIRST_DAYS,
            expanded: HashSet::new(),
            run_chat: None,
            list_scroll: ScrollHandle::new(),
            page_scroll: ScrollHandle::new(),
            flow: None,
            flow_last: HashMap::new(),
            next_id: 1,
            _editor: None,
        }
    }

    pub fn open_routine(&self) -> Option<&Routine> {
        self.open.as_deref().and_then(|id| self.routine(id))
    }

    pub fn routine(&self, id: &str) -> Option<&Routine> {
        self.routines.iter().find(|routine| routine.id == id)
    }

    pub fn routine_mut(&mut self, id: &str) -> Option<&mut Routine> {
        self.routines.iter_mut().find(|routine| routine.id == id)
    }

    /// The name a computer id has in the list (`computerName`).
    pub fn computer_name(id: &str) -> String {
        model::computer_name(id)
    }

    /// The Run Chat is open beside the page.
    pub fn run_pane_open(&self) -> bool {
        self.run_chat.is_some() && self.open.is_some() && self.editing.is_none()
    }

    /// Whether a Run's row opens its Chat (`canOpenRunChat`): the fixture keeps every Run Chat.
    pub fn can_open(&self, _chat: &str) -> bool {
        true
    }

    // ----- actions: what `act(routines:*)` does, on the view's own copy -----

    pub fn set_enabled(&mut self, id: &str, enabled: bool, cx: &mut Context<Self>) {
        let now = self.now;
        if let Some(routine) = self.routine_mut(id) {
            routine.enabled = enabled;
            if enabled && routine.paused_reason.take().is_some() {
                routine.last_error = None;
            }
            if !enabled {
                routine.next_run_at = None;
            } else if matches!(routine.trigger, Trigger::Schedule { .. }) && routine.next_run_at.is_none() {
                routine.next_run_at = Some(now + model::HOUR_MS);
            }
        }
        cx.notify();
    }

    /// Run now: a Running Run joins the top of the Routine's Runs.
    pub fn run_now(&mut self, id: &str, cx: &mut Context<Self>) {
        let (now, n) = (self.now, self.next_id);
        self.next_id += 1;
        if let Some(routine) = self.routine_mut(id) {
            let mut run = Run::new(format!("run-now-{n}"), now, RunStatus::Running);
            run.title = Some(routine.name.clone());
            routine.runs.insert(0, run);
            routine.run_count += 1;
            routine.last_run_at = Some(now);
        }
        cx.notify();
    }

    pub fn delete_routine(&mut self, id: &str, cx: &mut Context<Self>) {
        self.routines.retain(|routine| routine.id != id);
        self.confirming = None;
        if self.open.as_deref() == Some(id) {
            self.close_page();
        }
        cx.notify();
    }

    pub fn mark_read(&mut self, id: &str, cx: &mut Context<Self>) {
        self.unread_routines.remove(id);
        if let Some(routine) = self.routine(id) {
            let chats: Vec<String> = routine.runs.iter().filter_map(|run| run.chat_id.clone()).collect();
            for chat in chats {
                self.unread_chats.remove(&chat);
            }
        }
        cx.notify();
    }

    pub fn open_page(&mut self, id: &str, cx: &mut Context<Self>) {
        self.open = Some(id.to_string());
        self.reset_runs();
        cx.notify();
    }

    pub fn close_page(&mut self) {
        self.leave_flow();
        self.open = None;
        self.run_chat = None;
        self.created_hook = None;
        self.reset_runs();
    }

    fn reset_runs(&mut self) {
        self.run_filter = RunFilter::All;
        self.shown_days = runs::FIRST_DAYS;
        self.expanded.clear();
    }

    pub fn back(&mut self, cx: &mut Context<Self>) {
        self.close_page();
        cx.notify();
    }

    /// Opens a Run's Chat beside the Routine's page.
    pub fn open_run_chat(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let run = self.open_routine().and_then(|routine| routine.runs.iter().find(|run| run.chat_id.as_deref() == Some(key)).cloned());
        let title: SharedString = run
            .as_ref()
            .map(|run| words::run_title(run, self.open_routine().map_or("", |routine| routine.name.as_str())))
            .unwrap_or_else(|| "Chat".to_string())
            .into();
        self.unread_chats.remove(key);
        if let Some(chat) = &self.run_chat
            && chat.key == key
        {
            return;
        }
        let view = match self.run_chat.take() {
            Some(chat) => chat.view,
            None => cx.new(ChatView::new),
        };
        let row = page::chat_row(key, &title);
        view.update(cx, |chat, cx| chat.set_chat(&row, window, cx));
        self.run_chat = Some(RunChat { key: key.to_string(), title, run, view });
        cx.notify();
    }

    pub fn close_run_chat(&mut self, cx: &mut Context<Self>) {
        self.run_chat = None;
        cx.notify();
    }

    /// Edit or New Routine takes the page over; a Run Chat beside it closes.
    pub fn start_editor(&mut self, editing: Option<Editing>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editing) = editing else { return };
        self.run_chat = None;
        let initial = match &editing {
            Editing::New => None,
            Editing::Routine(id) => self.routine(id).cloned(),
        };
        let now = self.now;
        let editor = cx.new(|cx| RoutineEditor::new(initial, now, window, cx));
        self._editor = Some(cx.subscribe_in(&editor, window, |this, _, event: &EditorEvent, _, cx| this.on_editor(event, cx)));
        self.editing = Some(editing);
        self.editor = Some(editor);
        cx.notify();
    }

    fn close_editor(&mut self) {
        self.editing = None;
        self.editor = None;
        self._editor = None;
    }

    fn on_editor(&mut self, event: &EditorEvent, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Cancel => self.close_editor(),
            EditorEvent::Saved { id, patch } => {
                if let Some(routine) = self.routine_mut(id) {
                    form::apply_patch(routine, patch);
                }
                self.close_editor();
            }
            EditorEvent::Created { input, flow } => {
                let id = format!("rt-new-{}", self.next_id);
                self.next_id += 1;
                let mut routine = form::routine_from_input(&id, input, self.now);
                if *flow {
                    routine.flow = Some(model::FlowInfo::new(0, 0));
                }
                // A webhook's URL shows once, on its new page.
                if let Trigger::Webhook { hook_id, .. } = &routine.trigger {
                    self.created_hook = Some((id.clone(), format!("https://relay.milagre.cloud/hooks/{hook_id}")));
                }
                self.routines.push(routine);
                self.close_editor();
                self.open = Some(id);
                self.reset_runs();
            }
            EditorEvent::Deleted { id } => {
                self.routines.retain(|routine| &routine.id != id);
                self.close_editor();
                self.close_page();
            }
        }
        cx.notify();
    }

    /// The computer a Routine runs on.
    pub fn computer_of(routine: &Routine) -> &str {
        &routine.computer
    }

    /// A Chat's title for a Heartbeat's row and chip.
    pub fn chat_title(chat: &str) -> Option<String> {
        fixture::chat_title(chat)
    }
}

/// A Routine's icon (`routine-icon.ts`): a pulse for a Heartbeat, else what starts it.
pub fn routine_icon(routine: &Routine) -> IconName {
    if words::is_heartbeat(routine) {
        return IconName::Pulse01;
    }
    match &routine.trigger {
        Trigger::Webhook { .. } => IconName::Webhook,
        Trigger::Schedule { .. } | Trigger::PullRequest { .. } => IconName::Clock01,
        Trigger::Linear { event, .. } => match event {
            model::LinearEvent::Assigned => IconName::UserCheck01,
            model::LinearEvent::State => IconName::Flag02,
            model::LinearEvent::Comment => IconName::Comment01,
            model::LinearEvent::LabelAdded => IconName::Tag01,
        },
    }
}

/// Whether a Routine's Runs open a Chat of their own.
pub fn is_new_chat(routine: &Routine) -> bool {
    matches!(routine.target, Target::NewChat { .. })
}

impl Render for RoutinesView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let body: AnyElement = if let (Some(_), Some(editor)) = (&self.editing, &self.editor) {
            editor.clone().into_any_element()
        } else if self.open_routine().is_some() {
            self.render_page(window, cx)
        } else {
            self.render_list(window, cx)
        };
        div()
            .id("routines-view")
            .debug_selector(|| "routines-view".into())
            .flex()
            .flex_row()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.page)
            .text_color(theme.ink)
            .child(body)
    }
}

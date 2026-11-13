//! Flows (WP-46): the Flow page a flow Routine opens in place of the plain Routine page (R-06), its step inspectors (R-07)
//! and its Run view (R-08). After `apps/desktop/app/src/components/routines/` (`FlowPage`, `FlowSteps`, `FlowPopover`,
//! `FlowInspector`, `FlowRun`, `flow-look`) and `packages/shared/src/routine-flows.mjs`.
//!
//! | File | Holds |
//! | --- | --- |
//! | `types.rs` | `FlowStep`, `FlowRun`, what a Run keeps per step: `model.ts`'s flow types |
//! | `ops.rs` | `routine-flows.mjs`: step types, tree edits, what a step can read, the publish checks, words, drafts, Run rows |
//! | `look.rs` | `flow-look.ts`: tile colours, field glyphs, a Run's name, headline and state chip |
//! | `fixture.rs`, `act.rs` | the Review queue flow with seven Runs; what a Run does on Approve, Reject, Pause, Resume, End, Retry and Test run |
//! | `steps.rs` | the step list: cards, rails, + connectors, the Add step menu, empty paths, the first-step tiles |
//! | `inspector.rs`, `text.rs` | one form per step type, and the text that reads fields (`{{` list, Insert field) |
//! | `run.rs` | the Run bar, a Run's rows, and the approval, receipt and failure cards |
//! | `page.rs` | the page: header and toolbar, Draft chip, Publish and End Run dialogs, tabs, banners |
//!
//! The Flow page is part of [`RoutinesView`]: its state is [`FlowState`], made when a flow Routine's page opens and
//! dropped when the page closes, and its actions are `flow_*` methods on the view (the pieces call them). The draft is
//! edited in the state and saved into the Routine 600ms after the last edit (or at once when you leave, publish or test),
//! as the Mac's `flowDraft` would be; every action works on the view's own copy of the fixture.
//!
//! Not built: the page's sticky inspector column (it scrolls with the page), the Add step menu's arrow keys, and the
//! Publish dialog's busy state (the fixture publishes at once).

pub mod act;
pub mod fixture;
pub mod look;
pub mod ops;
pub mod types;

mod inspector;
mod page;
mod run;
mod steps;
mod text;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::time::Duration;

use gpui::{AppContext as _, Context, Entity, SharedString, Subscription, Task, Window};

use super::editor::{EditorEvent, RoutineEditor};
use super::model::Routine;
use super::{RoutinesView, form};
use crate::data::Millis;
use inspector::{InspectorCtx, InspectorEvent, StepInspector};
use look::trigger_kind;
use ops::{Where, flatten, flow_problems, insert_step, move_step, new_step, remove_step, replace_step};
use run::{Act, RunInspector};
use types::*;

/// How long an edit waits before the draft is saved.
const SAVE_DELAY: Duration = Duration::from_millis(600);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Steps,
    Runs,
    Settings,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Edit,
    Run,
}

/// Where each flow's page was left (tab, Edit draft or Show Run, the Run), so coming back from a Chat finds it there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastView {
    pub tab: Tab,
    pub mode: Mode,
    pub run_id: Option<String>,
}

/// The open Flow page.
pub struct FlowState {
    pub routine_id: String,
    /// The draft as it is edited.
    pub steps: Vec<FlowStep>,
    /// `"trigger"` or a step id.
    pub selected: Option<String>,
    pub tab: Tab,
    pub mode: Mode,
    pub run_id: Option<String>,
    /// The step each Run's view shows, by Run id.
    pub run_steps: HashMap<String, String>,
    pub error: Option<SharedString>,
    /// An edit is waiting for its save.
    pub pending: bool,
    /// Discard draft asked to be confirmed.
    pub discard_confirm: bool,
    pub(super) inspector: Option<Entity<StepInspector>>,
    pub(super) run_inspector: Option<Entity<RunInspector>>,
    pub(super) settings: Option<Entity<RoutineEditor>>,
    _subscriptions: Vec<Subscription>,
    _settings_subscription: Option<Subscription>,
    save: Option<Task<()>>,
}

impl RoutinesView {
    /// A flow Routine's page is open.
    pub(crate) fn is_flow_open(&self) -> bool {
        self.open_routine().is_some_and(|routine| routine.flow.is_some())
    }

    fn flow_routine(&self) -> Option<&Routine> {
        let id = self.flow.as_ref()?.routine_id.as_str();
        self.routine(id)
    }

    /// Opens the Flow page where a snapshot asks (`MILAGRE_GPUI_ROUTINES=flow-…`).
    pub(crate) fn start_flow(&mut self, start: super::FlowStart, cx: &mut Context<Self>) {
        use super::FlowStart as S;
        self.open = Some(if start == S::Empty { "rt-flow" } else { "rt-review" }.into());
        self.ensure_flow();
        match start {
            S::Draft | S::Empty => {}
            S::If => self.flow_select("if-large", cx),
            S::PullRequest => self.flow_select("pr", cx),
            S::Approval => self.flow_show_run("flow-14", cx),
            S::Ask => self.flow_show_run("flow-15", cx),
            S::Failed => self.flow_show_run("flow-13", cx),
            S::Receipt => {
                self.flow_show_run("flow-12", cx);
                self.flow_select_run_step("pr", cx);
            }
            S::Runs => self.flow_set_tab(Tab::Runs, cx),
            S::Settings => self.flow_set_tab(Tab::Settings, cx),
        }
    }

    /// Makes the page's state for the open flow Routine, saving the edit of the one it replaces.
    pub(crate) fn ensure_flow(&mut self) {
        let Some(routine) = self.open_routine() else { return };
        let id = routine.id.clone();
        if self.flow.as_ref().is_some_and(|flow| flow.routine_id == id) {
            return;
        }
        self.leave_flow();
        let Some(info) = self.routine(&id).and_then(|routine| routine.flow.clone()) else { return };
        let steps = info.def.draft.as_ref().map_or_else(|| info.def.steps.clone(), |draft| draft.steps.clone());
        let waiting: Vec<String> = self
            .routine(&id)
            .map(|routine| {
                routine.runs.iter().filter(|run| run.flow.as_ref().is_some_and(ops::needs_answer)).map(|run| run.id.clone()).collect()
            })
            .unwrap_or_default();
        let last = self.flow_last.get(&id).cloned();
        let selected = steps.first().map(|step| step.id.clone()).or_else(|| steps.is_empty().then(|| "trigger".to_string()));
        self.flow = Some(FlowState {
            routine_id: id,
            steps,
            selected,
            tab: last.as_ref().map_or(Tab::Steps, |last| last.tab),
            mode: last.as_ref().map_or(Mode::Edit, |last| last.mode),
            run_id: last.and_then(|last| last.run_id).or_else(|| waiting.first().cloned()),
            run_steps: HashMap::new(),
            error: None,
            pending: false,
            discard_confirm: false,
            inspector: None,
            run_inspector: None,
            settings: None,
            _subscriptions: Vec::new(),
            _settings_subscription: None,
            save: None,
        });
    }

    /// Leaving the page saves an edit still waiting and remembers where the page was left.
    pub(crate) fn leave_flow(&mut self) {
        if self.flow.as_ref().is_some_and(|flow| flow.pending) {
            self.save_draft();
        }
        if let Some(flow) = self.flow.take() {
            self.flow_last.insert(flow.routine_id, LastView { tab: flow.tab, mode: flow.mode, run_id: flow.run_id });
        }
    }

    /// Writes the draft into the Routine: no draft once it matches the published steps again (a flow never published keeps
    /// its draft, which is all it has).
    pub(crate) fn save_draft(&mut self) {
        let now = self.now;
        let Some(flow) = self.flow.as_mut() else { return };
        flow.pending = false;
        flow.save = None;
        let (id, steps) = (flow.routine_id.clone(), flow.steps.clone());
        if let Some(info) = self.routine_mut(&id).and_then(|routine| routine.flow.as_mut()) {
            info.def.draft = if info.revision > 0 && steps == info.def.steps { None } else { Some(Draft { steps, updated_at: now }) };
        }
    }

    /// Replaces the draft, selecting `select` (`Some(None)`: the first step, else the trigger), and saves it after a pause.
    pub(crate) fn flow_edit(&mut self, steps: Vec<FlowStep>, select: Option<Option<String>>, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_mut() else { return };
        flow.steps = steps;
        if let Some(select) = select {
            flow.selected = Some(select.or_else(|| flow.steps.first().map(|step| step.id.clone())).unwrap_or_else(|| "trigger".into()));
        }
        flow.pending = true;
        flow.error = None;
        flow.discard_confirm = false;
        flow.save = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_DELAY).await;
            this.update(cx, |this, cx| {
                this.save_draft();
                cx.notify();
            })
            .ok();
        }));
        self.push_inspector_context(cx);
        cx.notify();
    }

    pub(crate) fn flow_select(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.as_mut() {
            flow.selected = Some(id.to_string());
        }
        cx.notify();
    }

    pub(crate) fn flow_select_run_step(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.as_mut()
            && let Some(run) = flow.run_id.clone()
        {
            flow.run_steps.insert(run, id.to_string());
        }
        cx.notify();
    }

    pub(crate) fn flow_add(&mut self, kind: StepKind, where_: &Where, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_ref() else { return };
        let step = new_step(kind, &flow.steps);
        let id = step.id.clone();
        if let Ok(next) = insert_step(&flow.steps, where_, step) {
            self.flow_edit(next, Some(Some(id)), cx);
        }
    }

    pub(crate) fn flow_add_first(&mut self, kind: StepKind, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_ref() else { return };
        let step = new_step(kind, &flow.steps);
        let id = step.id.clone();
        let mut next = flow.steps.clone();
        next.push(step);
        self.flow_edit(next, Some(Some(id)), cx);
    }

    pub(crate) fn flow_move(&mut self, id: &str, by: i32, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_ref() else { return };
        let next = move_step(&flow.steps, id, by);
        self.flow_edit(next, None, cx);
    }

    pub(crate) fn flow_delete(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_ref() else { return };
        let next = remove_step(&flow.steps, id);
        self.flow_edit(next, Some(None), cx);
    }

    fn flow_edit_step(&mut self, step: &FlowStep, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_ref() else { return };
        let next = replace_step(&flow.steps, &step.id, step);
        self.flow_edit(next, None, cx);
    }

    pub(crate) fn flow_set_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.as_mut() {
            flow.tab = tab;
        }
        cx.notify();
    }

    pub(crate) fn flow_set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.as_mut() {
            flow.mode = mode;
        }
        cx.notify();
    }

    pub(crate) fn flow_open_settings(&mut self, cx: &mut Context<Self>) {
        self.flow_set_tab(Tab::Settings, cx);
    }

    /// Shows a Run in the Run view.
    pub(crate) fn flow_show_run(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.as_mut() {
            flow.tab = Tab::Steps;
            flow.mode = Mode::Run;
            flow.run_id = Some(id.to_string());
        }
        cx.notify();
    }

    pub(crate) fn flow_pick_run(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(flow) = self.flow.as_mut() {
            flow.run_id = Some(id.to_string());
        }
        cx.notify();
    }

    /// Opens the Chat a step ran in, beside the page.
    pub(crate) fn flow_open_chat(&mut self, chat: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_run_chat(chat, window, cx);
        let title = self.flow_routine().map(|routine| format!("{} step Chat", routine.name));
        if let (Some(run_chat), Some(title)) = (self.run_chat.as_mut(), title) {
            run_chat.title = title.into();
        }
    }

    /// The Run the view shows: the chosen one, else the first waiting for an answer, else the newest.
    pub(crate) fn flow_current_run(&self) -> Option<&super::model::Run> {
        let flow = self.flow.as_ref()?;
        let routine = self.routine(&flow.routine_id)?;
        let runs: Vec<&super::model::Run> = routine.runs.iter().filter(|run| run.flow.is_some()).collect();
        flow.run_id
            .as_deref()
            .and_then(|id| runs.iter().copied().find(|run| run.id == id))
            .or_else(|| runs.iter().copied().find(|run| run.flow.as_ref().is_some_and(ops::needs_answer)))
            .or_else(|| runs.first().copied())
    }

    /// Recounts the Runs waiting for an answer into the Routine's mark.
    fn recount_waiting(&mut self, id: &str) {
        if let Some(routine) = self.routine_mut(id) {
            let waiting = routine.runs.iter().filter(|run| run.flow.as_ref().is_some_and(ops::needs_answer)).count() as u32;
            if let Some(info) = routine.flow.as_mut() {
                info.waiting = waiting;
            }
        }
    }

    /// Approve, Reject, Pause, Resume, End or Retry on the Run shown (`routines:flow-act`).
    pub(crate) fn flow_act(&mut self, action: Act, cx: &mut Context<Self>) {
        let now = self.now;
        let Some(run_id) = self.flow_current_run().map(|run| run.id.clone()) else { return };
        let Some(id) = self.flow.as_ref().map(|flow| flow.routine_id.clone()) else { return };
        let result = self
            .routine_mut(&id)
            .and_then(|routine| routine.runs.iter_mut().find(|run| run.id == run_id))
            .map_or(Err("No such Run".to_string()), |run| act::apply(run, action, now));
        self.recount_waiting(&id);
        if let Some(flow) = self.flow.as_mut() {
            flow.error = result.err().map(Into::into);
            // The view follows the step the Run moved on to.
            flow.run_steps.remove(&run_id);
        }
        self.push_run_inspector(cx);
        cx.notify();
    }

    /// Run now: a Run of the published steps joins the top of the Runs, with its first step under way.
    pub(crate) fn flow_run_now(&mut self, cx: &mut Context<Self>) {
        let (now, n) = (self.now, self.next_id);
        self.next_id += 1;
        let Some(id) = self.flow.as_ref().map(|flow| flow.routine_id.clone()) else { return };
        let Some(routine) = self.routine_mut(&id) else { return };
        let Some(info) = routine.flow.as_ref() else { return };
        let flow_run = act::start(&info.def.steps, info.revision, now);
        let mut run = super::model::Run::new(format!("flow-now-{n}"), now, super::model::RunStatus::Running);
        run.flow = Some(flow_run);
        let run_id = run.id.clone();
        routine.runs.insert(0, run);
        routine.run_count += 1;
        routine.last_run_at = Some(now);
        self.flow_show_run(&run_id, cx);
    }

    /// Test run: saves the draft, and a dry run of it joins the top of the Runs.
    pub(crate) fn flow_test_run(&mut self, cx: &mut Context<Self>) {
        let now = self.now;
        if self.flow.as_ref().is_some_and(|flow| flow.pending) {
            self.save_draft();
        }
        let n = self.next_id;
        self.next_id += 1;
        let Some(flow) = self.flow.as_ref() else { return };
        let (id, steps) = (flow.routine_id.clone(), flow.steps.clone());
        let Some(routine) = self.routine_mut(&id) else { return };
        let revision = routine.flow.as_ref().map_or(0, |info| info.revision);
        let mut run = super::model::Run::new(format!("flow-test-{n}"), now, super::model::RunStatus::Acted);
        run.ended_at = Some(now);
        run.flow = Some(act::simulate(&steps, revision, now));
        let run_id = run.id.clone();
        routine.runs.insert(0, run);
        self.flow_show_run(&run_id, cx);
    }

    /// Publish revision N+1: the draft becomes the steps new Runs use. A Run in progress keeps its own.
    pub(crate) fn flow_publish(&mut self, cx: &mut Context<Self>) -> bool {
        let now = self.now;
        let Some(flow) = self.flow.as_mut() else { return false };
        flow.pending = false;
        flow.save = None;
        let (id, steps) = (flow.routine_id.clone(), flow.steps.clone());
        let trigger = self.routine(&id).map(|routine| trigger_kind(&routine.trigger));
        let Some(trigger) = trigger else { return false };
        let published = ops::check_flow_steps(&steps, trigger);
        let steps = match published {
            Ok(steps) => steps,
            Err(message) => {
                if let Some(flow) = self.flow.as_mut() {
                    flow.error = Some(message.into());
                }
                cx.notify();
                return false;
            }
        };
        if let Some(info) = self.routine_mut(&id).and_then(|routine| routine.flow.as_mut()) {
            info.revision += 1;
            info.def = FlowDef { steps: steps.clone(), published_at: now, draft: None };
        }
        if let Some(flow) = self.flow.as_mut() {
            flow.steps = steps;
            flow.error = None;
        }
        self.push_inspector_context(cx);
        cx.notify();
        true
    }

    /// Discard draft: back to the published steps.
    pub(crate) fn flow_discard(&mut self, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_mut() else { return };
        flow.pending = false;
        flow.save = None;
        flow.discard_confirm = false;
        let id = flow.routine_id.clone();
        let published = self.routine(&id).and_then(|routine| routine.flow.as_ref()).map(|info| info.def.steps.clone()).unwrap_or_default();
        if let Some(info) = self.routine_mut(&id).and_then(|routine| routine.flow.as_mut()) {
            info.def.draft = None;
        }
        if let Some(flow) = self.flow.as_mut() {
            let keep = flow.selected.clone().filter(|sel| sel == "trigger" || ops::find_step(&published, sel).is_some());
            flow.steps = published.clone();
            flow.selected = keep.or_else(|| published.first().map(|step| step.id.clone())).or(Some("trigger".into()));
            flow.inspector = None;
            flow._subscriptions.clear();
        }
        cx.notify();
    }

    /// The step a draft edit changed is what the inspector shows: it learns what the flow around it now offers.
    fn push_inspector_context(&mut self, cx: &mut Context<Self>) {
        let Some(inspector) = self.flow.as_ref().and_then(|flow| flow.inspector.clone()) else { return };
        let id = inspector.read(cx).step().id.clone();
        if let Some(ctx) = self.inspector_ctx(&id, cx) {
            inspector.update(cx, |inspector, cx| inspector.set_context(ctx, cx));
        }
    }

    /// The Mac's new copy of the Run arrived.
    fn push_run_inspector(&mut self, cx: &mut Context<Self>) {
        let Some(inspector) = self.flow.as_ref().and_then(|flow| flow.run_inspector.clone()) else { return };
        let Some(routine) = self.flow_routine().cloned() else { return };
        let run_id = inspector.read(cx).key().0.to_string();
        if let Some(run) = routine.runs.iter().find(|run| run.id == run_id).cloned() {
            inspector.update(cx, |inspector, cx| inspector.set_run(routine, run, cx));
        }
    }

    fn inspector_ctx(&self, id: &str, cx: &mut Context<Self>) -> Option<InspectorCtx> {
        let flow = self.flow.as_ref()?;
        let routine = self.routine(&flow.routine_id)?;
        let info = routine.flow.as_ref()?;
        let trigger = trigger_kind(&routine.trigger);
        let problems: Vec<String> = flow_problems(&flow.steps, trigger)
            .into_iter()
            .filter(|problem| problem.step_id.as_deref() == Some(id))
            .map(|problem| problem.message)
            .collect();
        let entry = flatten(&flow.steps).into_iter().find(|entry| entry.step.id == id)?;
        let siblings = match entry.parent_id {
            None => flow.steps.len(),
            Some(parent) => ops::find_step(&flow.steps, parent)
                .and_then(FlowStep::as_if)
                .map_or(0, |branching| branching.path(entry.branch.unwrap_or(Branch::Yes)).len()),
        };
        let published = ops::find_step(&info.def.steps, id);
        let status = match published {
            None if info.revision > 0 => Some("new in this draft"),
            None => None,
            Some(old) if Some(old) == ops::find_step(&flow.steps, id) => None,
            Some(_) => Some("edited in this draft"),
        };
        let test_issue = routine
            .runs
            .iter()
            .find(|run| run.event.is_some() && !run.flow.as_ref().is_some_and(|flow| flow.dry_run) && !run.rejected)
            .and_then(|run| look::run_issue_key(run).map(str::to_string));
        Some(InspectorCtx {
            view: cx.entity(),
            steps: flow.steps.clone(),
            trigger,
            status,
            problems,
            test_issue,
            can_up: entry.index > 0,
            can_down: entry.index + 1 < siblings,
        })
    }

    /// Makes the inspectors for what is selected, and the Settings form when its tab is open.
    pub(crate) fn sync_flow_children(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(flow) = self.flow.as_ref() else { return };
        // The step inspector, keyed by the selected step.
        let want = flow.selected.clone().filter(|sel| sel != "trigger" && ops::find_step(&flow.steps, sel).is_some());
        let have = flow.inspector.as_ref().map(|inspector| inspector.read(cx).step().id.clone());
        if want != have {
            let mut inspector = None;
            let mut subscriptions = Vec::new();
            if let Some(id) = &want
                && let Some(ctx) = self.inspector_ctx(id, cx)
                && let Some(step) = ops::find_step(&self.flow.as_ref().expect("flow").steps, id).cloned()
            {
                let entity = cx.new(|cx| StepInspector::new(step, ctx, window, cx));
                subscriptions.push(cx.subscribe(&entity, |this, _, event: &InspectorEvent, cx| {
                    let InspectorEvent::Change(step) = event;
                    this.flow_edit_step(step, cx);
                }));
                inspector = Some(entity);
            }
            if let Some(flow) = self.flow.as_mut() {
                flow.inspector = inspector;
                flow._subscriptions = subscriptions;
            }
        }
        // The Run's step inspector, keyed by Run and step.
        let Some(routine) = self.flow_routine().cloned() else { return };
        let run = self.flow_current_run().cloned();
        let flow = self.flow.as_ref().expect("flow");
        let step_id = run.as_ref().map(|run| flow.run_steps.get(&run.id).cloned().unwrap_or_else(|| look::default_run_step(Some(run))));
        let have = flow.run_inspector.as_ref().map(|inspector| {
            let (run, step) = inspector.read(cx).key();
            (run.to_string(), step.to_string())
        });
        let want = run.as_ref().zip(step_id.clone()).map(|(run, step)| (run.id.clone(), step));
        if want != have {
            let inspector = run.zip(step_id).map(|(run, step)| {
                let view = cx.entity();
                cx.new(|cx| RunInspector::new(view, routine.clone(), run, step, window, cx))
            });
            if let Some(flow) = self.flow.as_mut() {
                flow.run_inspector = inspector;
            }
        } else {
            self.push_run_inspector(cx);
        }
        // The Settings form.
        let flow = self.flow.as_ref().expect("flow");
        if flow.tab == Tab::Settings && flow.settings.is_none() {
            self.reset_flow_settings(window, cx);
        }
    }

    /// The Settings tab's form starts again from the Routine.
    pub(crate) fn reset_flow_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(routine) = self.flow_routine().cloned() else { return };
        let now = self.now;
        let editor = cx.new(|cx| RoutineEditor::new(Some(routine), now, window, cx));
        editor.update(cx, |editor, _| editor.embedded = true);
        let subscription =
            cx.subscribe_in(&editor, window, |this, _, event: &EditorEvent, window, cx| this.on_flow_settings(event, window, cx));
        if let Some(flow) = self.flow.as_mut() {
            flow.settings = Some(editor);
            flow._settings_subscription = Some(subscription);
        }
        cx.notify();
    }

    fn on_flow_settings(&mut self, event: &EditorEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            EditorEvent::Cancel => self.reset_flow_settings(window, cx),
            EditorEvent::Saved { id, patch } => {
                if let Some(routine) = self.routine_mut(id) {
                    form::apply_patch(routine, patch);
                }
                self.reset_flow_settings(window, cx);
            }
            EditorEvent::Deleted { id } => {
                self.routines.retain(|routine| &routine.id != id);
                self.close_page();
            }
            EditorEvent::Created { .. } => {}
        }
        cx.notify();
    }

    #[cfg(test)]
    pub(crate) fn flow_state(&self) -> Option<&FlowState> {
        self.flow.as_ref()
    }

    #[cfg(test)]
    pub(crate) fn flow_changes_now(&self) -> Vec<String> {
        let (Some(flow), Some(info)) = (self.flow.as_ref(), self.flow_routine().and_then(|routine| routine.flow.as_ref())) else {
            return Vec::new();
        };
        ops::flow_changes(&info.def.steps, &flow.steps)
    }
}

/// The time the fixture's flows are read at.
pub fn now() -> Millis {
    super::model::fixture_now()
}

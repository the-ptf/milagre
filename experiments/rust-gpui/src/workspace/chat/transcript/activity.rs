//! The activity fold and the transcript's tool items. After `agents/ActivityBlock.tsx` and `step-details.tsx`.
//!
//! A finished reply's thinking, tool steps and the text between them fold into one 24px line: up to four stacked
//! 20px circular marks (one per kind of work), the summary the app writes ("Thought for 12s · read 6 files · ran 2
//! commands", `summary::activity_summary`), a chevron and the duration. Clicking it opens the steps; clicking
//! again folds them. A reply with one step has no fold: it is that step's row. While the turn streams the line
//! shows what the agent is doing now (the running step's title, shimmering) or "Working". Settings › Chat
//! › Tool call display "Full detail" skips the fold; "Always expand reasoning" opens thinking rows.
//!
//! The rows of an open fold are drawn inside the fold's own list item, so opening, closing or expanding a row
//! re-measures that item only (`ListState::splice` over one index). Long folds (over 200 entries) open at the
//! last 150, with a button for the earlier ones (`activity-window.ts`).
//!
//! Not built: the fold's height transition (`grid-template-rows`, 280ms), a waiting step's Deny and Allow on the
//! fold's line (the approval package), markdown in the text between steps (plain text), the Linear mark.

use std::collections::BTreeSet;
use std::rc::Rc;

use gpui::{AnyElement, ClickEvent, Context, ElementId, FontWeight, SharedString, div, prelude::*, px};

use super::step_row::{self, Click, ROW_BLEED, StepRow};
use super::summary::{self, Entry};
use super::{Item, Transcript};
use crate::data::{ChatMessage, ChatStep, Millis, StepKind, StepStatus};
use crate::logic::lists::chat_display::ToolCallDisplay;
use crate::theme::{CONTROL_XS, RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};

const MARK_SIZE: f32 = 20.0;
const MARK_OVERLAP: f32 = 6.0;

/// Which rows the reader opened, and which console blocks they asked to see whole.
#[derive(Clone, Debug, Default)]
pub struct RowState {
    /// Steps whose open state differs from their default (thinking follows "Always expand reasoning").
    flipped: BTreeSet<SharedString>,
    all_lines: BTreeSet<SharedString>,
}

impl RowState {
    fn is_open(&self, step: &ChatStep, expand_reasoning: bool) -> bool {
        let default = expand_reasoning && step.kind == Some(StepKind::Thinking);
        default != self.flipped.contains(&step.id)
    }
}

/// A reply's activity, drawn as a fold.
#[derive(Clone, Debug)]
pub struct Activity {
    pub entries: Vec<Entry>,
    /// The reply is still being written: the line says what the agent is doing now.
    pub streaming: bool,
    pub open: bool,
    /// Where the first open started (`None` until it opened): earlier entries stay behind a button.
    pub boundary: Option<usize>,
    /// Steps waiting on an approval.
    pub waiting: Vec<SharedString>,
    /// What the turn cost, Kiro only.
    pub credits: Option<f64>,
    /// The clock a running step counts from; the transcript has no ticking clock yet.
    pub now: Millis,
    pub rows: RowState,
}

impl Activity {
    pub fn new(entries: Vec<Entry>, now: Millis) -> Self {
        Self { entries, streaming: false, open: false, boundary: None, waiting: Vec::new(), credits: None, now, rows: RowState::default() }
    }

    /// Opens the rows of steps `ids` (what a reader's clicks do), for fixtures and snapshots.
    pub fn with_open_rows(mut self, ids: &[&str]) -> Self {
        self.open = true;
        self.boundary = Some(0);
        self.rows.flipped.extend(ids.iter().map(|id| SharedString::from(id.to_string())));
        self
    }

    /// The fold of a saved reply (`replyActivity`): the activity before its answer. `None` when it did nothing.
    pub fn of_message(message: &ChatMessage, now: Millis) -> Option<(Activity, String)> {
        let (entries, answer) = summary::reply_activity(&message.body, &message.steps);
        (!entries.is_empty()).then(|| {
            let mut activity = Activity::new(entries, now);
            activity.credits = message.credits;
            (activity, answer)
        })
    }

    pub fn steps(&self) -> Vec<&ChatStep> {
        self.entries.iter().filter_map(Entry::step).collect()
    }

    /// The step the line speaks for while streaming: the one waiting on approval, else the last running one.
    fn current(&self) -> Option<&ChatStep> {
        if !self.streaming {
            return None;
        }
        let steps = self.steps();
        steps
            .iter()
            .find(|step| step.status == StepStatus::Running && self.waiting.contains(&step.id))
            .or_else(|| steps.iter().rev().find(|step| step.status == StepStatus::Running))
            .copied()
    }

    fn clock(&self, step: &ChatStep) -> Clock {
        Clock { now: self.now, waiting: self.waiting.contains(&step.id) }
    }

    /// A lone step needs no fold.
    fn lone_step(&self) -> Option<&ChatStep> {
        match self.entries.as_slice() {
            [Entry::Step(step)] => Some(step),
            _ => None,
        }
    }
}

/// What a row needs besides its step: the clock a running step counts from, and whether it waits on an approval.
#[derive(Clone, Copy)]
pub(super) struct Clock {
    pub now: Millis,
    pub waiting: bool,
}

/// A step that stands alone in the transcript (a call between two pieces of text).
#[derive(Clone, Debug)]
pub struct StepItem {
    pub step: ChatStep,
    pub now: Millis,
    pub rows: RowState,
}

impl StepItem {
    pub fn new(step: ChatStep, now: Millis) -> Self {
        Self { step, now, rows: RowState::default() }
    }
}

impl Transcript {
    /// Re-measures item `ix` after a row opened or closed: the list keeps every measured height.
    fn changed(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.list.splice(ix..ix + 1, 1);
        cx.notify();
    }

    fn rows_mut(&mut self, ix: usize) -> Option<&mut RowState> {
        match self.items.get_mut(ix) {
            Some(Item::Activity(activity)) => Some(&mut activity.rows),
            Some(Item::Step(item)) => Some(&mut item.rows),
            _ => None,
        }
    }

    /// Opens or folds the activity at `ix`; the first open fixes where a long fold starts.
    pub fn toggle_fold(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(Item::Activity(activity)) = self.items.get_mut(ix) else { return };
        if activity.boundary.is_none() {
            activity.boundary = Some(summary::activity_boundary(&activity.entries, &activity.waiting, activity.streaming, None));
        }
        activity.open = !activity.open;
        self.changed(ix, cx);
    }

    /// A live run's fold at `ix` with its steps as they are now (`streaming`: it is the run's last fold, whose line
    /// says what runs now), `waiting` the steps on an approval and `now` the clock running steps count from. What the
    /// reader opened stays open. Re-measured only when something it shows changed.
    pub fn update_activity(
        &mut self,
        ix: usize,
        entries: Vec<Entry>,
        streaming: bool,
        waiting: Vec<SharedString>,
        now: Millis,
        cx: &mut Context<Self>,
    ) {
        let Some(Item::Activity(activity)) = self.items.get_mut(ix) else { return };
        let running = entries.iter().filter_map(Entry::step).any(|step| step.status == StepStatus::Running);
        if activity.entries == entries
            && activity.streaming == streaming
            && activity.waiting == waiting
            && !(running && activity.now != now)
        {
            return;
        }
        activity.entries = entries;
        activity.streaming = streaming;
        activity.waiting = waiting;
        activity.now = now;
        self.changed(ix, cx);
    }

    /// The display clock (`useDisplayValue`, once a second) for the live folds at `ixs`: a fold with a running step is
    /// drawn again at `now`. Whether any of them still runs.
    pub fn tick_activities(&mut self, ixs: &[usize], now: Millis, cx: &mut Context<Self>) -> bool {
        let mut any = false;
        for &ix in ixs {
            let Some(Item::Activity(activity)) = self.items.get_mut(ix) else { continue };
            if activity.steps().iter().any(|step| step.status == StepStatus::Running) {
                activity.now = now;
                any = true;
                self.changed(ix, cx);
            }
        }
        any
    }

    /// Reveals every earlier entry of a long fold.
    pub fn show_earlier(&mut self, ix: usize, cx: &mut Context<Self>) {
        if let Some(Item::Activity(activity)) = self.items.get_mut(ix) {
            activity.boundary = Some(0);
            self.changed(ix, cx);
        }
    }

    /// Opens or closes one step's detail in item `ix`.
    pub fn flip_step(&mut self, ix: usize, id: SharedString, cx: &mut Context<Self>) {
        let Some(rows) = self.rows_mut(ix) else { return };
        if !rows.flipped.remove(&id) {
            rows.flipped.insert(id);
        }
        self.changed(ix, cx);
    }

    /// Shows a console block whole instead of its last 40 lines.
    pub fn show_all_lines(&mut self, ix: usize, id: SharedString, cx: &mut Context<Self>) {
        let Some(rows) = self.rows_mut(ix) else { return };
        rows.all_lines.insert(id);
        self.changed(ix, cx);
    }

    /// Whether the detail of step `id` in item `ix` is open.
    pub fn step_open(&self, ix: usize, id: &str) -> bool {
        match self.items.get(ix) {
            Some(Item::Activity(activity)) => {
                activity.steps().iter().find(|step| step.id == id).is_some_and(|step| activity.rows.is_open(step, self.expand_reasoning))
            }
            Some(Item::Step(item)) => item.step.id == id && item.rows.is_open(&item.step, self.expand_reasoning),
            _ => false,
        }
    }

    /// One row, wired to this transcript: `n` is its place in the item.
    pub(super) fn step_element(
        &self,
        (ix, n): (usize, usize),
        step: &ChatStep,
        rows: &RowState,
        clock: Clock,
        theme: &Theme,
        cx: &Context<Self>,
    ) -> AnyElement {
        let id = step.id.clone();
        let on_toggle: Click = Rc::new(cx.listener({
            let id = id.clone();
            move |this, _: &ClickEvent, _window, cx| this.flip_step(ix, id.clone(), cx)
        }));
        let on_all: Click = Rc::new(cx.listener({
            let id = id.clone();
            move |this, _: &ClickEvent, _window, cx| this.show_all_lines(ix, id.clone(), cx)
        }));
        let view = StepRow {
            step,
            key: (ix, n),
            open: rows.is_open(step, self.expand_reasoning),
            all_lines: rows.all_lines.contains(&id),
            waiting: clock.waiting,
            now: clock.now,
            on_toggle: Some(on_toggle),
            on_all: Some(on_all),
        };
        step_row::step(&view, theme)
    }

    pub(super) fn step_item(&self, ix: usize, item: &StepItem, theme: &Theme, cx: &Context<Self>) -> AnyElement {
        self.step_element((ix, 0), &item.step, &item.rows, Clock { now: item.now, waiting: false }, theme, cx)
    }

    pub(super) fn activity_item(&self, ix: usize, activity: &Activity, theme: &Theme, cx: &Context<Self>) -> AnyElement {
        // Nothing to fold: no row (Electron's `ActivityBlock` draws nothing for an empty group), never a bare chevron.
        if activity.entries.is_empty() {
            return div().into_any_element();
        }
        let text_between = |text: &SharedString| {
            div().px(px(0.0)).py_1().text_step(TEXT_12).line_height(px(12.0 * 1.55)).text_color(theme.ink2).child(text.clone())
        };
        let entry = |n: usize, entry: &Entry| match entry {
            Entry::Step(step) => self.step_element((ix, n), step, &activity.rows, activity.clock(step), theme, cx),
            Entry::Text(text) => text_between(text).into_any_element(),
        };
        if self.display == ToolCallDisplay::Full {
            return div()
                .flex()
                .flex_col()
                .min_w_0()
                .children(activity.entries.iter().enumerate().map(|(n, e)| entry(n, e)))
                .into_any_element();
        }
        if let Some(step) = activity.lone_step() {
            return self.step_element((ix, 0), step, &activity.rows, activity.clock(step), theme, cx);
        }
        let hidden = match activity.boundary {
            Some(boundary) => summary::activity_boundary(&activity.entries, &activity.waiting, activity.streaming, Some(boundary)),
            None => 0,
        };
        let body = activity.open.then(|| {
            div()
                .debug_selector(|| "activity-body".into())
                .flex()
                .flex_col()
                .min_w_0()
                .mt(px(2.0))
                .when(hidden > 0, |body| {
                    let label = summary::earlier_steps_label(&activity.entries, hidden);
                    body.child(
                        div().child(
                            Button::new(ElementId::from((SharedString::from("earlier-steps"), ix)), label)
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S24)
                                .selector("activity-earlier")
                                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.show_earlier(ix, cx))),
                        ),
                    )
                })
                .children(activity.entries.iter().enumerate().skip(hidden).map(|(n, e)| entry(n, e)))
        });
        div().flex().flex_col().min_w_0().child(self.fold_line(ix, activity, theme, cx)).children(body).into_any_element()
    }

    /// The fold's line: marks, the summary or what runs now, a failed count, the chevron and the duration.
    fn fold_line(&self, ix: usize, activity: &Activity, theme: &Theme, cx: &Context<Self>) -> AnyElement {
        let steps = activity.steps();
        let current = activity.current();
        let waiting = current.is_some_and(|step| activity.waiting.contains(&step.id));
        let (text, failed) = summary::activity_summary(&steps, activity.credits);
        let running = steps.iter().filter(|step| step.status == StepStatus::Running).count();
        let elapsed = summary::activity_duration(&steps, activity.streaming, activity.now);
        let marks: Vec<IconName> = match current {
            Some(step) if waiting => vec![step_row::kind_icon(step.kind)],
            _ => summary::activity_sources(&steps).iter().map(step_row::source_icon).collect(),
        };
        // The marks' row gets an explicit width: a hugging flex row of children with negative margins measures
        // 0px wide, and the summary would land on the marks.
        let marks_width = if marks.is_empty() { 0.0 } else { MARK_SIZE + (marks.len() - 1) as f32 * (MARK_SIZE - MARK_OVERLAP) };
        let mark = |n: usize, icon: IconName| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(MARK_SIZE))
                .when(n > 0, |mark| mark.ml(px(-MARK_OVERLAP)))
                .rounded_full()
                .bg(theme.field)
                .border_2()
                .border_color(theme.page)
                .child(Icon::new(icon).size(IconSize::S12).color(theme.ink2))
        };
        let label: AnyElement = match current {
            Some(_) if running > 1 && !waiting => div().child(format!("Running {running} calls")).into_any_element(),
            Some(step) => step_row::title(&summary::step_display_title(step, !waiting), (ix, usize::MAX), theme.ink2, !waiting, theme),
            None if activity.streaming => div().child("Working").into_any_element(),
            None => div().child(text).into_any_element(),
        };
        let group: SharedString = "fold-row".into();
        div()
            .id(ElementId::from((SharedString::from("fold"), ix)))
            .debug_selector(|| "activity-line".into())
            .group(group.clone())
            .relative()
            .flex()
            .items_center()
            .gap_2()
            .h(CONTROL_XS)
            .w_full()
            .min_w_0()
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| this.toggle_fold(ix, cx)))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(-ROW_BLEED))
                    .right(px(-ROW_BLEED))
                    .rounded(RADIUS_CONTROL)
                    .group_hover(group, |style| style.bg(theme.hover)),
            )
            .child(
                div()
                    .debug_selector(|| "activity-marks".into())
                    .flex()
                    .flex_none()
                    .w(px(marks_width))
                    .children(marks.into_iter().enumerate().map(|(n, icon)| mark(n, icon))),
            )
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .overflow_hidden()
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink2)
                    .child(label),
            )
            .when(waiting, |line| {
                line.child(
                    div()
                        .flex_none()
                        .text_step(TEXT_11)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.orange_ink)
                        .child("Waiting for approval"),
                )
            })
            .when(failed > 0, |line| {
                line.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap_1()
                        .text_step(TEXT_11)
                        .text_color(theme.red_ink)
                        .child(Icon::new(IconName::Alert02).size(IconSize::S12).color(theme.red_ink))
                        .child(format!("{failed} failed")),
                )
            })
            .when(activity.streaming && !waiting, |line| {
                line.child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(format!("{} calls", steps.len())))
            })
            .child(div().flex_1())
            .child(step_row::chevron_slot(true, activity.open, false, theme))
            .when(!elapsed.is_empty(), |line| {
                line.child(div().flex_none().min_w(px(40.0)).flex().justify_end().text_step(TEXT_11).text_color(theme.ink3).child(elapsed))
            })
            .into_any_element()
    }
}

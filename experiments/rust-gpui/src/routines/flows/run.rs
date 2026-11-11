//! The Run view (R-08: `FlowRun.tsx`): the bar over a Run (which Run, its state, its issue, the revision it ran), a Run's
//! steps as it ran them with each step's state and an If's taken path, and the selected step's inspector: the approval
//! waiting on you (or the pull request it would open), the receipt an action kept, a failure with its tries and Retry
//! with a note, a step's output, and Open Chat.

use gpui::{AnyElement, Context, Entity, EventEmitter, FontWeight, IntoElement, Render, Rgba, SharedString, Window, div, prelude::*, px};
use gpui_component::input::TextareaState;

use super::inspector::inspector_card;
use super::look::{clock_with_date, first_line, flow_status_look, run_headline, run_name, took_text, trigger_run_text, trigger_title};
use super::ops::{RunRow, failed_step, flatten, flow_run_text, needs_answer, output_summary, run_rows, step_reads, step_title};
use super::steps::{Card, INDENT, RAIL, flow_card, path_label};
use super::types::*;
use crate::data::Millis;
use crate::routines::RoutinesView;
use crate::routines::model::{Routine, Run};
use crate::routines::words::{ZONE, clock};
use crate::theme::{ActiveTheme, RADIUS_CHIP, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, Select, SelectOption, SelectVariant, SpinnerRing, TextArea};

/// What a person does to a Run (`FlowAct`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    Approve,
    Reject { reason: Option<String> },
    Pause,
    Resume,
    End,
    Retry { note: Option<String> },
}

/// A step's state as an icon at the end of its row.
fn state_icon(status: StepStatus, theme: &Theme) -> AnyElement {
    let (icon, ink, label) = match status {
        StepStatus::Done => (IconName::CheckmarkCircle02, theme.green, "Done"),
        StepStatus::Waiting => (IconName::PauseCircle, theme.orange, "Waiting"),
        StepStatus::Running => {
            let ring = SpinnerRing::new().size(14.0).color(theme.accent);
            let ring = if crate::ui::motion() { ring.animated("flow-running-ring") } else { ring };
            return div()
                .debug_selector(|| "flow-state-running".into())
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(20.0))
                .child(ring)
                .into_any_element();
        }
        StepStatus::Failed => (IconName::CancelCircle, theme.red, "Failed"),
        StepStatus::Pending => (IconName::DashedLineCircle, theme.ink4, "Not started"),
        StepStatus::Skipped => (IconName::MinusSignCircle, theme.ink4, "Skipped"),
        StepStatus::NotTaken => (IconName::MinusSignCircle, theme.ink4, "Not taken"),
        StepStatus::NotRun => (IconName::MinusSignCircle, theme.ink4, "Did not run"),
    };
    let selector = format!("flow-state-{}", status.id());
    let _ = label;
    div()
        .debug_selector(move || selector.clone())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(20.0))
        .child(Icon::new(icon).size(IconSize::S16).color(ink))
        .into_any_element()
}

/// What a step's row says under its name, and in which ink (`rowText`).
fn row_text(step: &FlowStep, status: StepStatus, state: Option<&StepRun>, now: Millis, theme: &Theme) -> (String, Rgba) {
    let quiet = theme.ink3;
    match (status, state) {
        (StepStatus::NotTaken, _) => ("Not taken".into(), quiet),
        (StepStatus::NotRun, _) => ("Did not run".into(), quiet),
        (StepStatus::Pending, _) | (_, None) => ("Not started".into(), quiet),
        (StepStatus::Skipped, Some(state)) => (state.summary.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "Skipped".into()), quiet),
        (StepStatus::Running, Some(state)) => {
            let own = if matches!(&step.body, StepBody::Agent(agent) if agent.chat == ChatUse::Own) { " in its own Chat" } else { "" };
            (
                match state.started_at {
                    Some(started) => format!("Running for {}{own}", took_text(now - started)),
                    None => format!("Running{own}"),
                },
                theme.accent_ink,
            )
        }
        (StepStatus::Waiting, Some(state)) => match &state.approval {
            Some(approval) if approval.decision.is_none() => {
                (format!("Waiting for you since {}", clock(approval.asked_at, &ZONE)), theme.orange_ink)
            }
            _ => (
                state.wait_until.map_or("Waiting".to_string(), |until| format!("Waiting, up to {}", clock(until, &ZONE))),
                theme.orange_ink,
            ),
        },
        (StepStatus::Failed, Some(state)) => {
            let tries = state.tries.len() + 1;
            let error = Some(first_line(state.error.as_deref())).filter(|e| !e.is_empty()).unwrap_or_else(|| "Failed".into());
            (if tries > 1 { format!("Failed {tries} times, {error}") } else { error }, theme.red_ink)
        }
        (StepStatus::Done, Some(state)) => {
            let mut parts = vec![state.summary.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| output_summary(&state.output))];
            if state.summary.is_none()
                && let Some(Approval { decision: Some(Decision::Approved), decided_at: Some(at), .. }) = &state.approval
            {
                parts.push(format!("approved at {}", clock(*at, &ZONE)));
            }
            if let (StepKind::Agent, Some(started), Some(ended)) = (step.kind(), state.started_at, state.ended_at) {
                parts.push(took_text(ended - started));
            }
            let text = parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(", ");
            (if text.is_empty() { "Done".into() } else { text }, quiet)
        }
    }
}

/// The bar over a Run: which Run (a picker over the flow's Runs), its state, its issue, the revision it ran and when it
/// started; with a draft open, a lock says the Run shows its own steps, not the draft.
pub(crate) fn run_bar(view: &Entity<RoutinesView>, routine: &Routine, runs: &[&Run], run: &Run, draft: bool, theme: &Theme) -> AnyElement {
    let flow = run.flow.as_ref().expect("a flow Run");
    let (text, tone) = flow_status_look(flow, needs_answer(flow));
    let chip = if matches!(flow.status, FlowStatus::Failed | FlowStatus::Paused) {
        flow_run_text(flow, run.error.as_deref())
    } else {
        text.to_string()
    };
    let (fill, ink) = tone.colors(theme);
    let options: Vec<SelectOption> = runs
        .iter()
        .map(|entry| {
            let entry_flow = entry.flow.as_ref().expect("a flow Run");
            SelectOption::new(entry.id.clone(), super::look::run_name(routine, entry)).description(format!(
                "{} \u{b7} {}",
                run_headline(entry),
                flow_run_text(entry_flow, entry.error.as_deref())
            ))
        })
        .collect();
    let picker_view = view.clone();
    div()
        .debug_selector(|| "flow-run-bar".into())
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(12.0))
        .gap_y(px(4.0))
        .min_h(px(44.0))
        .px(px(12.0))
        .py(px(6.0))
        .rounded(crate::theme::RADIUS_CARD)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .child(
            Select::new("flow-run-picker", run.id.clone(), options)
                .variant(SelectVariant::Chip)
                .compact()
                .align_start()
                .width(340.0)
                .on_change(move |id, _, cx| {
                    let id = id.to_string();
                    picker_view.update(cx, |this, cx| this.flow_pick_run(&id, cx));
                }),
        )
        .child(
            div()
                .debug_selector({
                    let status = flow.status.id();
                    move || format!("flow-run-status-{status}")
                })
                .flex()
                .flex_none()
                .items_center()
                .h(px(24.0))
                .px(px(8.0))
                .rounded(RADIUS_CHIP)
                .bg(fill)
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(ink)
                .child(chip),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink)
                .child(run_headline(run)),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.0))
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(format!(
                    "revision {}, started {}{}",
                    flow.revision,
                    clock(run.started_at, &ZONE),
                    if draft { ", your draft is hidden" } else { "" }
                ))
                .when(draft, |el| el.child(Icon::new(IconName::Lock).size(IconSize::S14).color(theme.ink3))),
        )
        .into_any_element()
}

/// A thin rail between rows; green once the row under it has been reached.
fn rail(reached: bool, theme: &Theme) -> AnyElement {
    div()
        .relative()
        .h(px(24.0))
        .child(div().absolute().top_0().bottom_0().left(px(RAIL)).w(px(1.0)).bg(if reached { theme.green } else { theme.line_strong }))
        .into_any_element()
}

/// A Run's steps as it ran them: the trigger, then each step's row with its state (done, waiting for you, running, failed,
/// not started, did not run), an If's paths under it with the one taken marked.
pub(crate) fn run_rows_view(
    view: &Entity<RoutinesView>,
    routine: &Routine,
    run: &Run,
    selected: Option<&str>,
    now: Millis,
    theme: &Theme,
) -> AnyElement {
    let flow = run.flow.as_ref().expect("a flow Run");
    let rows = run_rows(flow);
    let vertical_rails = |depth: usize| {
        (0..depth).map(|index| {
            div().absolute().top_0().bottom_0().left(px(index as f32 * INDENT + RAIL)).w(px(1.0)).bg(theme.line_strong).into_any_element()
        })
    };
    let open_chat = |chat: &Option<String>| -> Option<AnyElement> {
        let chat = chat.clone()?;
        let view = view.clone();
        let selector = format!("flow-open-chat-{chat}");
        Some(
            div()
                .id(SharedString::from(selector.clone()))
                .debug_selector(move || selector.clone())
                .flex()
                .flex_none()
                .items_center()
                .h(px(28.0))
                .px(px(8.0))
                .rounded(RADIUS_CONTROL)
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.accent_ink)
                .cursor_pointer()
                .hover({
                    let tint = theme.accent_tint;
                    move |style| style.bg(tint)
                })
                .on_click(move |_, window, cx| {
                    let chat = chat.clone();
                    view.update(cx, |this, cx| this.flow_open_chat(&chat, window, cx));
                })
                .child("Open Chat")
                .into_any_element(),
        )
    };

    let mut trigger = Card::new("flow-run-step-trigger", None, trigger_title(&routine.trigger), trigger_run_text(routine, run));
    trigger.selected = selected == Some("trigger");
    trigger.menu = Some(state_icon(StepStatus::Done, theme));
    let select_view = view.clone();
    let mut out = vec![flow_card(trigger, move |_, cx| select_view.update(cx, |this, cx| this.flow_select_run_step("trigger", cx)), theme)];
    for (index, row) in rows.iter().enumerate() {
        match row {
            RunRow::Path { path, parent_id, depth, taken, decided, .. } => {
                let text = match (path, decided, taken) {
                    (Branch::Yes, true, true) => "Yes, taken",
                    (Branch::Yes, true, false) => "Yes, not taken",
                    (Branch::Yes, false, _) => "Yes",
                    (Branch::Otherwise, true, true) => "Otherwise, taken",
                    (Branch::Otherwise, true, false) => "Otherwise, not taken",
                    (Branch::Otherwise, false, _) => "Otherwise",
                };
                let (fill, ink) = if *taken {
                    (theme.green_tint, theme.green_ink)
                } else if *decided {
                    (theme.field, theme.ink3)
                } else {
                    (theme.field, theme.ink2)
                };
                let selector = format!("flow-run-path-{parent_id}:{}", path.id());
                out.push(
                    div()
                        .debug_selector(move || selector.clone())
                        .relative()
                        .pl(px((*depth as f32 - 1.0) * INDENT))
                        .children(vertical_rails(*depth))
                        .child(path_label(text, fill, ink, theme))
                        .into_any_element(),
                );
            }
            RunRow::Step { step, depth, status, run: state } => {
                let previous = index.checked_sub(1).and_then(|at| rows.get(at));
                let reached = !matches!(status, StepStatus::Pending | StepStatus::NotRun | StepStatus::NotTaken);
                let (words, tone) = row_text(step, *status, *state, now, theme);
                let ring = match (status, state) {
                    (StepStatus::Waiting, Some(state)) if state.approval.as_ref().is_some_and(|a| a.decision.is_none()) => {
                        Some(theme.orange)
                    }
                    (StepStatus::Failed, _) => Some(theme.red),
                    _ => None,
                };
                let mut card = Card::new(format!("flow-run-step-{}", step.id), Some(step.kind()), step_title(step), words);
                card.subtitle_ink = Some(tone);
                card.selected = selected == Some(step.id.as_str());
                card.ring = ring;
                card.dim = !reached;
                let mut menu = div().flex().items_center().gap(px(4.0));
                if let Some(chat) = state.and_then(|state| open_chat(&state.chat_id)) {
                    menu = menu.child(chat);
                }
                if state.is_some_and(|state| state.receipt.is_some()) {
                    menu = menu.child(
                        div()
                            .debug_selector(|| "flow-receipt-kept".into())
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(20.0))
                            .child(Icon::new(IconName::Invoice03).size(IconSize::S14).color(theme.green_ink)),
                    );
                }
                card.menu = Some(menu.child(state_icon(*status, theme)).into_any_element());
                let (select_view, id) = (view.clone(), step.id.clone());
                let mut item = div().relative().pl(px(*depth as f32 * INDENT)).children(vertical_rails(*depth));
                if !matches!(previous, Some(RunRow::Path { .. })) {
                    item = item.child(rail(reached, theme));
                }
                out.push(
                    item.child(flow_card(card, move |_, cx| select_view.update(cx, |this, cx| this.flow_select_run_step(&id, cx)), theme))
                        .into_any_element(),
                );
            }
        }
    }
    let selector = format!("flow-run-rows-{}", run.id);
    div().debug_selector(move || selector.clone()).children(out).into_any_element()
}

// ----- the selected step -----

/// Label and value rows in a bordered table: the pull request preview and the receipt.
fn table(header: Option<AnyElement>, rows: Vec<(String, AnyElement)>, theme: &Theme) -> AnyElement {
    let last = rows.len().saturating_sub(1);
    div()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .children(header)
        .children(rows.into_iter().enumerate().map(|(index, (label, value))| {
            div()
                .flex()
                .gap(px(12.0))
                .px(px(12.0))
                .py(px(8.0))
                .when(index < last, |el| el.border_b_1().border_color(theme.line))
                .child(div().w(px(112.0)).flex_none().text_step(TEXT_13).text_color(theme.ink2).child(label))
                .child(div().flex_1().min_w_0().text_step(TEXT_13).text_color(theme.ink).child(value))
        }))
        .into_any_element()
}

fn text_value(text: impl Into<SharedString>) -> AnyElement {
    div().child(text.into()).into_any_element()
}

fn note(icon: IconName, fill: Rgba, ink: Rgba, text: impl Into<SharedString>) -> AnyElement {
    div()
        .flex()
        .items_start()
        .gap(px(8.0))
        .rounded(RADIUS_CONTROL)
        .bg(fill)
        .px(px(12.0))
        .py(px(8.0))
        .text_step(TEXT_12)
        .text_color(ink)
        .child(div().mt(px(1.0)).flex_none().child(Icon::new(icon).size(IconSize::S14).color(ink)))
        .child(div().flex_1().min_w_0().child(text.into()))
        .into_any_element()
}

/// A button that fills its row: the Run view's primary and secondary buttons.
#[allow(clippy::too_many_arguments)]
fn wide_button(
    id: &str,
    label: &str,
    icon: Option<IconName>,
    primary: bool,
    danger: bool,
    disabled: bool,
    on_click: impl Fn(&mut Window, &mut gpui::App) + 'static,
    theme: &Theme,
) -> AnyElement {
    let theme = *theme;
    let (fill, ink, hover) = if primary {
        (theme.ink, theme.on_ink, theme.ink)
    } else {
        (theme.field, if danger { theme.red_ink } else { theme.ink }, theme.hover2)
    };
    let id = id.to_string();
    div()
        .id(SharedString::from(id.clone()))
        .debug_selector(move || id.clone())
        .flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .h(px(32.0))
        .px(px(12.0))
        .rounded(RADIUS_CONTROL)
        .bg(fill)
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink)
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| {
            el.cursor_pointer()
                .hover(move |style| if primary { style.opacity(0.9) } else { style.bg(hover) })
                .on_click(move |_, window, cx| on_click(window, cx))
        })
        .children(icon.map(|icon| Icon::new(icon).size(IconSize::S14).color(ink)))
        .child(label.to_string())
        .into_any_element()
}

pub enum RunInspectorEvent {}

impl EventEmitter<RunInspectorEvent> for RunInspector {}

/// The selected step of a Run, in the inspector. An entity for the two text areas it can hold (a reason on Reject, a note
/// on Retry) and the buttons that open them; the page makes a new one for each Run and step, as React keys it.
pub struct RunInspector {
    view: Entity<RoutinesView>,
    routine: Routine,
    run: Run,
    step_id: String,
    reason: Entity<TextareaState>,
    note: Entity<TextareaState>,
    rejecting: bool,
    noting: bool,
    copied: bool,
    busy: bool,
}

impl RunInspector {
    pub fn new(
        view: Entity<RoutinesView>,
        routine: Routine,
        run: Run,
        step_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let reason = TextArea::state("Why not? The Run ends with your reason.", (3, 8), window, cx);
        let note = TextArea::state("What should go differently this time?", (3, 8), window, cx);
        Self { view, routine, run, step_id, reason, note, rejecting: false, noting: false, copied: false, busy: false }
    }

    /// The Mac's new copy of the Run arrived.
    pub fn set_run(&mut self, routine: Routine, run: Run, cx: &mut Context<Self>) {
        self.routine = routine;
        self.run = run;
        self.busy = false;
        cx.notify();
    }

    pub fn key(&self) -> (&str, &str) {
        (&self.run.id, &self.step_id)
    }

    #[cfg(test)]
    pub fn set_reason(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.reason.update(cx, |state, cx| state.set_value(text.to_string(), window, cx));
    }

    fn act(&mut self, act: Act, cx: &mut Context<Self>) {
        self.busy = true;
        let view = self.view.clone();
        cx.notify();
        cx.defer(move |cx| view.update(cx, |this, cx| this.flow_act(act, cx)));
    }

    fn approval_card(&self, step: &FlowStep, state: &StepRun, name: &str, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let approval = state.approval.as_ref().expect("a pending approval");
        let this = cx.entity();
        let mut out = div().debug_selector(|| "flow-approval".into()).flex().flex_col().gap(px(12.0));
        if let Some(preview) = &approval.preview {
            let mut rows: Vec<(String, AnyElement)> = Vec::new();
            if let Some(repository) = &preview.repository {
                rows.push(("Repository".into(), text_value(repository.clone())));
            }
            rows.push(("Branches".into(), text_value(format!("{} into {}", preview.branch, preview.base))));
            rows.push(("Title".into(), text_value(preview.title.clone())));
            if let Some(changes) = &preview.changes {
                rows.push(("Changes".into(), text_value(changes.clone())));
            }
            rows.push(("Opens as".into(), text_value(if preview.draft { "Draft PR" } else { "Ready PR" })));
            out = out
                .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("This will open"))
                .child(table(None, rows, theme));
            if step.kind() == StepKind::PullRequest {
                out = out.child(note(
                    IconName::Invoice03,
                    theme.green_tint,
                    theme.green_ink,
                    format!("Keeps a receipt. If {name} restarts, it finds this pull request by branch instead of opening a second one."),
                ));
            }
        } else {
            out = out.child(
                div()
                    .debug_selector(|| "flow-approval-message".into())
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.field)
                    .px(px(12.0))
                    .py(px(8.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink)
                    .child(if approval.message.is_empty() { "Approve to go on.".to_string() } else { approval.message.clone() }),
            );
        }
        let busy = self.busy;
        if self.rejecting {
            let (cancel, reject) = (this.clone(), this.clone());
            out = out.child(
                div().flex().flex_col().gap(px(8.0)).child(TextArea::new("flow-reject-reason", &self.reason)).child(
                    div()
                        .flex()
                        .gap(px(8.0))
                        .child(wide_button(
                            "flow-reject-cancel",
                            "Cancel",
                            None,
                            false,
                            false,
                            false,
                            move |_, cx| {
                                cancel.update(cx, |this, cx| {
                                    this.rejecting = false;
                                    cx.notify();
                                })
                            },
                            theme,
                        ))
                        .child(wide_button(
                            "flow-reject",
                            "Reject",
                            None,
                            false,
                            true,
                            busy,
                            move |_, cx| {
                                reject.update(cx, |this, cx| {
                                    let reason = this.reason.read(cx).value().trim().to_string();
                                    this.act(Act::Reject { reason: Some(reason).filter(|r| !r.is_empty()) }, cx);
                                })
                            },
                            theme,
                        )),
                ),
            );
        } else {
            let (approve, start) = (this.clone(), this.clone());
            let label = match &approval.preview {
                Some(preview) if preview.draft => "Open draft PR",
                Some(_) => "Open PR",
                None => "Approve",
            };
            out = out.child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(wide_button(
                        "flow-approve",
                        label,
                        None,
                        true,
                        false,
                        busy,
                        move |_, cx| approve.update(cx, |this, cx| this.act(Act::Approve, cx)),
                        theme,
                    ))
                    .child(wide_button(
                        "flow-reject-start",
                        "Reject with reason",
                        None,
                        false,
                        false,
                        false,
                        move |_, cx| {
                            start.update(cx, |this, cx| {
                                this.rejecting = true;
                                cx.notify();
                            })
                        },
                        theme,
                    )),
            );
        }
        out.child(
            div()
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(format!("Rejecting ends {name}. No answer by {} ends it too.", clock_with_date(approval.expires_at))),
        )
        .into_any_element()
    }

    fn receipt_card(&self, name: &str, receipt: &Receipt, readers: &[String], theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let this = cx.entity();
        let header = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .py(px(8.0))
            .bg(theme.green_tint)
            .text_step(TEXT_13)
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.green_ink)
            .child(Icon::new(IconName::Invoice03).size(IconSize::S14).color(theme.green_ink))
            .child(div().flex_1().child("Receipt"))
            .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).child(format!("saved {}", clock(receipt.at(), &ZONE))))
            .into_any_element();
        let link = |text: String| -> AnyElement {
            div().text_color(if receipt.url().is_some() { theme.accent_ink } else { theme.ink }).child(text).into_any_element()
        };
        let rows: Vec<(String, AnyElement)> = match receipt {
            Receipt::PullRequest { number, draft, branch, matched, .. } => vec![
                ("Pull request".into(), link(format!("#{number}{}", if *draft { ", draft" } else { "" }))),
                (
                    "Matched by".into(),
                    text_value(if *matched { format!("branch {branch}, already open") } else { format!("opened from {branch}") }),
                ),
                (
                    "Gave".into(),
                    text_value(if readers.is_empty() { "url".to_string() } else { format!("url, read by {}", readers.join(", ")) }),
                ),
            ],
            Receipt::LinearComment { issue, .. } => vec![("Comment".into(), link(format!("On {issue}")))],
        };
        let mut out =
            div().debug_selector(|| "flow-receipt".into()).flex().flex_col().gap(px(12.0)).child(table(Some(header), rows, theme));
        if let Receipt::PullRequest { number, .. } = receipt {
            out = out.child(
                div().text_step(TEXT_12).text_color(theme.ink3).child(format!("If {name} restarts, this step finds #{number} and skips.")),
            );
        }
        if let Some(url) = receipt.url() {
            let copy_url = url.to_string();
            let copied = self.copied;
            out = out.child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(wide_button(
                        "flow-receipt-open",
                        if matches!(receipt, Receipt::PullRequest { .. }) { "Open on GitHub" } else { "Open on Linear" },
                        Some(IconName::LinkSquare02),
                        true,
                        false,
                        false,
                        {
                            let url = url.to_string();
                            move |_, cx| cx.open_url(&url)
                        },
                        theme,
                    ))
                    .child(wide_button(
                        "flow-receipt-copy",
                        if copied { "Copied" } else { "Copy link" },
                        Some(if copied { IconName::Tick02 } else { IconName::Copy01 }),
                        false,
                        false,
                        false,
                        move |_, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(copy_url.clone()));
                            this.update(cx, |this, cx| {
                                this.copied = true;
                                cx.notify();
                            });
                        },
                        theme,
                    )),
            );
        }
        out.into_any_element()
    }

    /// A step the Run stopped at: its error, each try with its Chat, what has left the Mac, and Retry with a note.
    fn failed_card(
        &self,
        step: &FlowStep,
        state: &StepRun,
        name: &str,
        can_retry: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let this = cx.entity();
        let flow = self.run.flow.as_ref().expect("a flow Run");
        let mut tries: Vec<Try> = state.tries.clone();
        if let Some(started) = state.started_at {
            tries.push(Try {
                started_at: started,
                ended_at: state.ended_at.unwrap_or(started),
                error: state.error.clone().unwrap_or_else(|| "Failed".into()),
                chat_id: state.chat_id.clone(),
            });
        }
        let receipts: Vec<&Receipt> =
            flatten(&flow.steps).iter().filter_map(|entry| flow.state.get(&entry.step.id)?.receipt.as_ref()).collect();
        let left = if receipts.is_empty() {
            "No action receipt is recorded. Check the last Chat for any effects of its tools.".to_string()
        } else {
            let list: Vec<String> = receipts
                .iter()
                .map(|receipt| match receipt {
                    Receipt::PullRequest { number, .. } => format!("pull request #{number}"),
                    Receipt::LinearComment { issue, .. } => format!("a comment on {issue}"),
                })
                .collect();
            format!("Already done: {}.", list.join(", "))
        };
        let last_chat = tries.iter().rev().find_map(|entry| entry.chat_id.clone());
        let mut out = div().debug_selector(|| "flow-failed".into()).flex().flex_col().gap(px(12.0)).child(note(
            IconName::Alert02,
            theme.red_tint,
            theme.red_ink,
            state.error.clone().unwrap_or_else(|| "The step failed.".into()),
        ));
        if !tries.is_empty() {
            let last = tries.len() - 1;
            out = out.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Tries"))
                    .child(div().flex().flex_col().rounded(RADIUS_CONTROL).border_1().border_color(theme.line).children(
                        tries.iter().enumerate().map(|(index, entry)| {
                            let chat = entry.chat_id.clone();
                            let view = self.view.clone();
                            div()
                                .debug_selector(move || format!("flow-try-{}", index + 1))
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .min_h(px(36.0))
                                .px(px(12.0))
                                .py(px(6.0))
                                .when(index < last, |el| el.border_b_1().border_color(theme.line))
                                .child(Icon::new(IconName::CancelCircle).size(IconSize::S14).color(theme.red))
                                .child(div().flex_1().min_w_0().truncate().text_step(TEXT_13).text_color(theme.ink).child(format!(
                                    "Try {}, {}, {}",
                                    index + 1,
                                    took_text(entry.ended_at - entry.started_at),
                                    first_line(Some(&entry.error))
                                )))
                                .when_some(chat, |el, chat| {
                                    el.child(
                                        div()
                                            .id(SharedString::from(format!("flow-try-chat-{index}")))
                                            .text_step(TEXT_12)
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.accent_ink)
                                            .cursor_pointer()
                                            .on_click(move |_, window, cx| {
                                                let chat = chat.clone();
                                                view.update(cx, |this, cx| this.flow_open_chat(&chat, window, cx));
                                            })
                                            .child("Chat"),
                                    )
                                })
                        }),
                    )),
            );
        }
        out = out.child(note(IconName::Shield01, theme.page, theme.ink2, format!("{left} The Worktree and its commits stay.")));
        if self.noting {
            out = out.child(TextArea::new("flow-retry-note", &self.note));
        }
        let mut buttons = div().flex().gap(px(8.0));
        if can_retry {
            let noting = self.noting;
            buttons = buttons.child(wide_button(
                "flow-retry",
                if noting { "Retry" } else { "Retry with a note" },
                Some(IconName::Refresh),
                true,
                false,
                self.busy,
                move |_, cx| {
                    this.update(cx, |this, cx| {
                        if !this.noting {
                            this.noting = true;
                            cx.notify();
                            return;
                        }
                        let note = this.note.read(cx).value().trim().to_string();
                        this.act(Act::Retry { note: Some(note).filter(|n| !n.is_empty()) }, cx);
                    })
                },
                theme,
            ));
        }
        if let Some(chat) = last_chat {
            let view = self.view.clone();
            buttons = buttons.child(wide_button(
                "flow-open-last-chat",
                "Open last Chat",
                None,
                false,
                false,
                false,
                move |window, cx| {
                    let chat = chat.clone();
                    view.update(cx, |this, cx| this.flow_open_chat(&chat, window, cx));
                },
                theme,
            ));
        }
        out = out.child(buttons);
        if can_retry {
            out = out.child(div().text_step(TEXT_12).text_color(theme.ink3).child(format!(
                "Retry runs {} again in the same Worktree{}. Later steps run as usual. {name} keeps its place.",
                step_title(step),
                if step.kind() == StepKind::Agent { " with your note added to the prompt" } else { "" }
            )));
        }
        out.into_any_element()
    }
}

impl Render for RunInspector {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let routine = self.routine.clone();
        let run = self.run.clone();
        let flow = run.flow.as_ref().expect("a flow Run");
        let name = run_name(&routine, &run);
        let issue = match &run.event {
            Some(RunEvent::Linear { issue, .. }) => Some(issue.clone()),
            _ => None,
        };
        if self.step_id == "trigger" || self.step_id.is_empty() {
            let body: AnyElement = match issue {
                Some(issue) => div()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(div().text_step(TEXT_13).text_color(theme.ink).child(format!("{} {}", issue.key, issue.title)))
                    .child(div().text_step(TEXT_12).text_color(theme.ink3).child(format!(
                        "{}{}",
                        issue.state,
                        if issue.labels.is_empty() { String::new() } else { format!(", {}", issue.labels.join(", ")) }
                    )))
                    .when(issue.url.is_some(), |el| {
                        let url = issue.url.clone().unwrap_or_default();
                        el.child(
                            div()
                                .id("flow-open-linear")
                                .text_step(TEXT_13)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.accent_ink)
                                .cursor_pointer()
                                .on_click(move |_, _, cx| cx.open_url(&url))
                                .child("Open on Linear"),
                        )
                    })
                    .into_any_element(),
                None => div()
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child(if flow.dry_run {
                        "Simulation of the draft. Agents use sample or saved fields. Actions and waits do not run."
                    } else {
                        "The trigger started this Run."
                    })
                    .into_any_element(),
            };
            return inspector_card(
                "flow-run-inspector-trigger".into(),
                None,
                trigger_title(&routine.trigger).to_string(),
                trigger_run_text(&routine, &run),
                None,
                vec![body],
                &theme,
            );
        }
        let Some(step) = flatten(&flow.steps).into_iter().find(|entry| entry.step.id == self.step_id).map(|entry| entry.step.clone())
        else {
            return div().into_any_element();
        };
        let status = run_rows(flow)
            .into_iter()
            .find_map(|row| match row {
                RunRow::Step { step: s, status, .. } if s.id == step.id => Some(status),
                _ => None,
            })
            .unwrap_or(StepStatus::Pending);
        let state = flow.state.get(&step.id).cloned();
        let pending_approval =
            status == StepStatus::Waiting && state.as_ref().and_then(|s| s.approval.as_ref()).is_some_and(|a| a.decision.is_none());
        let stopped = failed_step(flow);
        let subtitle = match &state {
            None => {
                if matches!(flow.status, FlowStatus::Failed | FlowStatus::Ended) {
                    "Did not run".to_string()
                } else {
                    "Not started".to_string()
                }
            }
            Some(_) if status == StepStatus::Pending => {
                if matches!(flow.status, FlowStatus::Failed | FlowStatus::Ended) {
                    "Did not run".to_string()
                } else {
                    "Not started".to_string()
                }
            }
            Some(_) if status == StepStatus::NotTaken => "Not taken".into(),
            Some(_) if status == StepStatus::NotRun => match stopped {
                Some(stopped) => format!("Did not run: the Run stopped at {}", step_title(stopped)),
                None => "Did not run".into(),
            },
            Some(_) if pending_approval => {
                if step.kind() == StepKind::PullRequest {
                    "Action, asks you before it runs".into()
                } else {
                    "Approval, waiting for you".into()
                }
            }
            Some(_) if status == StepStatus::Waiting => "Waiting".into(),
            Some(state) if status == StepStatus::Running => {
                state.started_at.map_or("Running".to_string(), |at| format!("Running since {}", clock(at, &ZONE)))
            }
            Some(state) if status == StepStatus::Failed => {
                let tries = state.tries.len() + 1;
                format!(
                    "Stopped{}{}",
                    state.ended_at.map_or(String::new(), |at| format!(" at {}", clock(at, &ZONE))),
                    if tries > 1 { format!(" after {tries} tries") } else { String::new() }
                )
            }
            Some(state) if status == StepStatus::Skipped => state.summary.clone().unwrap_or_else(|| "Skipped".into()),
            Some(state) => {
                let approval = match &state.approval {
                    Some(Approval { decision: Some(Decision::Approved), decided_at: Some(at), .. }) => {
                        format!(", approved at {}", clock(*at, &ZONE))
                    }
                    _ => String::new(),
                };
                format!("Done{}{approval}", state.ended_at.map_or(String::new(), |at| format!(" at {}", clock(at, &ZONE))))
            }
        };
        let readers: Vec<String> = match state.as_ref().and_then(|s| s.receipt.as_ref()) {
            Some(Receipt::PullRequest { .. }) => flatten(&flow.steps)
                .into_iter()
                .filter(|entry| step_reads(entry.step).contains(&format!("{}.url", step.id)))
                .map(|entry| entry.step.name.clone())
                .collect(),
            _ => Vec::new(),
        };
        let mut children: Vec<AnyElement> = Vec::new();
        if pending_approval && let Some(state) = &state {
            children.push(self.approval_card(&step, state, &name, &theme, cx));
        }
        if let Some(Approval { decision: Some(decision), decided_at, reason, .. }) = state.as_ref().and_then(|s| s.approval.as_ref()) {
            let at = decided_at.map_or(String::new(), |at| format!(" at {}", clock(at, &ZONE)));
            let text = match decision {
                Decision::Approved => format!("Approved{at}"),
                Decision::Rejected => format!("Rejected{at}{}", reason.as_ref().map_or(String::new(), |r| format!(": {r}"))),
                Decision::Expired => "No answer in time".to_string(),
            };
            children.push(
                div().debug_selector(|| "flow-decision".into()).text_step(TEXT_13).text_color(theme.ink2).child(text).into_any_element(),
            );
        }
        if let Some(receipt) = state.as_ref().and_then(|s| s.receipt.as_ref()) {
            children.push(self.receipt_card(&name, receipt, &readers, &theme, cx));
        }
        if status == StepStatus::Failed
            && let Some(state) = &state
        {
            children.push(self.failed_card(&step, state, &name, flow.status == FlowStatus::Failed, &theme, cx));
        }
        if let Some(state) = state.as_ref().filter(|s| !s.output.is_empty()) {
            let rows = state
                .output
                .iter()
                .map(|(key, value)| {
                    let text = match value {
                        Value::Bool(on) => {
                            if *on {
                                "yes".to_string()
                            } else {
                                "no".to_string()
                            }
                        }
                        Value::Num(n) => n.to_string(),
                        Value::Text(text) => text.clone(),
                        _ => String::new(),
                    };
                    (key.clone(), text_value(text))
                })
                .collect();
            children.push(div().debug_selector(|| "flow-output-table".into()).child(table(None, rows, &theme)).into_any_element());
        }
        if let Some(note_text) = state.as_ref().and_then(|s| s.note.clone()) {
            children.push(note(IconName::Refresh, theme.page, theme.ink2, format!("Your note on retry: {note_text}")));
        }
        if status != StepStatus::Failed
            && let Some(chat) = state.as_ref().and_then(|s| s.chat_id.clone())
        {
            let view = self.view.clone();
            let theme_copy = theme;
            children.push(
                div()
                    .flex()
                    .child(
                        div()
                            .id("flow-inspector-open-chat")
                            .flex()
                            .items_center()
                            .h(px(32.0))
                            .px(px(12.0))
                            .rounded(RADIUS_CONTROL)
                            .bg(theme.surface)
                            .shadow(theme.shadow_btn())
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme_copy.hover))
                            .on_click(move |_, window, cx| {
                                let chat = chat.clone();
                                view.update(cx, |this, cx| this.flow_open_chat(&chat, window, cx));
                            })
                            .child("Open Chat"),
                    )
                    .into_any_element(),
            );
        }
        inspector_card(format!("flow-run-inspector-{}", step.id), Some(step.kind()), step_title(&step), subtitle, None, children, &theme)
    }
}

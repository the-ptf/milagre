//! The Flow page (R-06: `FlowPage.tsx`): a flow Routine's name with the Flow chip, the draft's changes and the revision it
//! runs; Test run and Publish while editing, Pause, Resume and End while showing a Run. Under it Steps (Edit draft: the
//! list editor and the selected step's inspector; Show Run: a Run's steps as it ran them and the selected step's
//! approval, receipt or failure), Runs and Settings (the Routine form in place). With a Run Chat open beside it the
//! inspector goes under the list.

use std::collections::HashMap;

use gpui::{AnyElement, Context, Entity, FontWeight, IntoElement, Window, div, prelude::*, px};

use super::inspector::trigger_inspector;
use super::look::{run_issue_key, run_name, trigger_kind, trigger_sentence, trigger_title};
use super::ops::{current_step, flow_changes, flow_problems, needs_answer, step_title};
use super::run::{Act, run_bar, run_rows_view};
use super::steps::{Card, ListData, flow_card, next_step_tiles, short_rail, step_list};
use super::types::*;
use super::{Mode, Tab};
use crate::routines::RoutinesView;
use crate::routines::list::act;
use crate::routines::model::Run;
use crate::routines::words::{self, can_run_now, clock, routine_problem, trigger_chip_text};
use crate::theme::{
    ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TEXT_22, TextStepExt, Theme,
};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, InlineError, Popover, ScrollArea, Segmented, SegmentedOption, Tooltip,
};

const PAGE_WIDTH: f32 = 1040.0;
/// The inspector's column beside the list.
const INSPECTOR_WIDTH: f32 = 384.0;

fn count_text(n: usize) -> String {
    if n == 1 { "1 change".into() } else { format!("{n} changes") }
}

/// "Draft, 3 changes": what the draft changes, with Discard draft behind a confirm.
fn draft_chip(view: &Entity<RoutinesView>, changes: &[String], theme: &Theme) -> AnyElement {
    let theme = *theme;
    let label = format!("Draft, {}", count_text(changes.len()));
    let lines = changes.to_vec();
    let content_view = view.clone();
    Popover::new("flow-draft-chip")
        .align_start()
        .width(px(320.0))
        .trigger(move |open| {
            div()
                .id("flow-draft-chip")
                .debug_selector(|| "flow-draft-chip".into())
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.0))
                .h(px(24.0))
                .px(px(8.0))
                .rounded(RADIUS_CHIP)
                .bg(if open { theme.hover2 } else { theme.field })
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(if open { theme.ink } else { theme.ink2 })
                .cursor_pointer()
                .hover(move |style| style.bg(theme.hover2).text_color(theme.ink))
                .child(label.clone())
                .child(Icon::new(IconName::ArrowDown01).size(IconSize::S12).color(theme.ink3))
                .into_any_element()
        })
        .content(move |dismiss, _window, cx| {
            let theme = *cx.theme();
            let (ask, keep, discard) = (content_view.clone(), content_view.clone(), content_view.clone());
            let dismiss = dismiss.clone();
            let list = div()
                .id("flow-draft-list")
                .debug_selector(|| "flow-draft-menu".into())
                .flex()
                .flex_col()
                .max_h(px(192.0))
                .overflow_y_scroll()
                .px(px(8.0))
                .pt(px(4.0))
                .pb(px(8.0))
                .children(
                    lines.iter().map(|line| div().truncate().py(px(2.0)).text_step(TEXT_12).text_color(theme.ink2).child(line.clone())),
                );
            let asking = content_view.read(cx).flow.as_ref().is_some_and(|flow| flow.discard_confirm);
            let footer: AnyElement = if asking {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .border_t_1()
                    .border_color(theme.line)
                    .px(px(8.0))
                    .pt(px(8.0))
                    .child(div().flex_1().min_w_0().text_step(TEXT_12).text_color(theme.ink).child("Discard the draft and its changes?"))
                    .child(Button::new("flow-discard-keep", "Keep").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                        move |_, window, cx| {
                            keep.update(cx, |this, cx| {
                                if let Some(flow) = this.flow.as_mut() {
                                    flow.discard_confirm = false;
                                }
                                cx.notify();
                            });
                            window.refresh();
                        },
                    ))
                    .child(
                        Button::new("flow-discard-confirm", "Discard").variant(ButtonVariant::DangerGhost).size(ButtonSize::S28).on_click(
                            move |_, window, cx| {
                                dismiss.call(window, cx);
                                discard.update(cx, |this, cx| this.flow_discard(cx));
                            },
                        ),
                    )
                    .into_any_element()
            } else {
                crate::ui::MenuList::new("flow-draft-actions")
                    .row(crate::ui::MenuRow::new("flow-discard", "Discard draft").icon(IconName::Delete02).danger().on_click(
                        move |_, window, cx| {
                            ask.update(cx, |this, cx| {
                                if let Some(flow) = this.flow.as_mut() {
                                    flow.discard_confirm = true;
                                }
                                cx.notify();
                            });
                            window.refresh();
                        },
                    ))
                    .into_any_element()
            };
            div().flex().flex_col().child(list).child(footer).into_any_element()
        })
        .into_any_element()
}

/// Publish revision N+1: what changes, what Runs in progress keep, then Publish.
fn publish_button(
    view: &Entity<RoutinesView>,
    revision: u32,
    changes: &[String],
    problem: Option<String>,
    in_progress: &[String],
    waiting: bool,
    theme: &Theme,
) -> AnyElement {
    let next = revision + 1;
    let blocked = problem.or_else(|| (revision > 0 && changes.is_empty()).then(|| "No changes to publish".to_string()));
    let label = format!("Publish revision {next}");
    if let Some(reason) = blocked {
        return div()
            .id("flow-publish-blocked")
            .tooltip(Tooltip::text(reason))
            .child(Button::new("flow-publish", label).disabled(true))
            .into_any_element();
    }
    let note = if revision == 0 {
        "New Runs use revision 1 once you turn the flow on.".to_string()
    } else if !in_progress.is_empty() {
        format!(
            "{} {} revision {revision}{}. New Runs use revision {next}.",
            in_progress.join(", "),
            if in_progress.len() == 1 { "keeps" } else { "keep" },
            if waiting { " and still waits for you" } else { "" }
        )
    } else {
        format!("Runs in progress keep revision {revision}. New Runs use revision {next}.")
    };
    let sub =
        if revision == 0 { "The first revision".to_string() } else { format!("{} since revision {revision}", count_text(changes.len())) };
    let (lines, content_view) = (changes.to_vec(), view.clone());
    let theme = *theme;
    Popover::new("flow-publish-popover")
        .width(px(380.0))
        .trigger(move |_| Button::new("flow-publish", label.clone()).into_any_element())
        .content(move |dismiss, _window, _cx| {
            let (cancel, confirm, dismiss_cancel, dismiss_confirm) =
                (dismiss.clone(), content_view.clone(), dismiss.clone(), dismiss.clone());
            let _ = cancel;
            div()
                .debug_selector(|| "flow-publish-dialog".into())
                .flex()
                .flex_col()
                .p(px(10.0))
                .child(
                    div()
                        .text_step(TEXT_15)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.ink)
                        .child(format!("Publish revision {next}")),
                )
                .child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(sub.clone()))
                .child(
                    div()
                        .id("flow-publish-changes")
                        .mt(px(12.0))
                        .flex()
                        .flex_col()
                        .max_h(px(192.0))
                        .overflow_y_scroll()
                        .rounded(RADIUS_CONTROL)
                        .bg(theme.field)
                        .children(lines.iter().enumerate().map(|(index, line)| {
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .px(px(12.0))
                                .py(px(8.0))
                                .when(index > 0, |el| el.border_t_1().border_color(theme.line))
                                .text_step(TEXT_13)
                                .text_color(theme.ink)
                                .child(Icon::new(IconName::PencilEdit02).size(IconSize::S14).color(theme.ink3))
                                .child(div().flex_1().min_w_0().truncate().child(line.clone()))
                        })),
                )
                .child(
                    div()
                        .mt(px(12.0))
                        .flex()
                        .items_start()
                        .gap(px(8.0))
                        .rounded(RADIUS_CONTROL)
                        .bg(theme.orange_tint)
                        .px(px(12.0))
                        .py(px(8.0))
                        .text_step(TEXT_12)
                        .text_color(theme.orange_ink)
                        .child(
                            div().mt(px(1.0)).flex_none().child(Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.orange_ink)),
                        )
                        .child(div().flex_1().min_w_0().child(note.clone())),
                )
                .child(
                    div()
                        .mt(px(16.0))
                        .flex()
                        .justify_end()
                        .gap(px(8.0))
                        .child(
                            Button::new("flow-publish-cancel", "Cancel")
                                .variant(ButtonVariant::Secondary)
                                .on_click(move |_, window, cx| dismiss_cancel.call(window, cx)),
                        )
                        .child(Button::new("flow-publish-confirm", format!("Publish revision {next}")).on_click(move |_, window, cx| {
                            dismiss_confirm.call(window, cx);
                            confirm.update(cx, |this, cx| {
                                this.flow_publish(cx);
                            });
                        })),
                )
                .into_any_element()
        })
        .into_any_element()
}

/// End Run, behind a confirm.
fn end_run_button(view: &Entity<RoutinesView>, name: String, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let content_view = view.clone();
    Popover::new("flow-end-popover")
        .width(px(300.0))
        .trigger(|_| Button::new("flow-end", "End Run").variant(ButtonVariant::Secondary).icon(IconName::Stop).into_any_element())
        .content(move |dismiss, _window, _cx| {
            let (dismiss_cancel, dismiss_end, end) = (dismiss.clone(), dismiss.clone(), content_view.clone());
            div()
                .debug_selector(|| "flow-end-dialog".into())
                .flex()
                .flex_col()
                .p(px(10.0))
                .child(div().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(format!("End {name}?")))
                .child(
                    div()
                        .mt(px(4.0))
                        .text_step(TEXT_12)
                        .text_color(theme.ink2)
                        .child("It stops where it is. What it already did stays, and its Worktree too."),
                )
                .child(
                    div()
                        .mt(px(16.0))
                        .flex()
                        .justify_end()
                        .gap(px(8.0))
                        .child(
                            Button::new("flow-end-cancel", "Cancel")
                                .variant(ButtonVariant::Secondary)
                                .on_click(move |_, window, cx| dismiss_cancel.call(window, cx)),
                        )
                        .child(Button::new("flow-end-confirm", "End Run").variant(ButtonVariant::DangerGhost).on_click(
                            move |_, window, cx| {
                                dismiss_end.call(window, cx);
                                end.update(cx, |this, cx| this.flow_act(Act::End, cx));
                            },
                        )),
                )
                .into_any_element()
        })
        .into_any_element()
}

/// The "On, revision 3" pill: a switch that turns the flow on and off.
fn revision_pill(view: &Entity<RoutinesView>, enabled: bool, revision: u32, id: &str, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let (fill, ink, dot) = if enabled { (theme.green_tint, theme.green_ink, theme.green) } else { (theme.field, theme.ink2, theme.ink4) };
    let text = if revision == 0 {
        "Off, not published".to_string()
    } else {
        format!("{}, revision {revision}", if enabled { "On" } else { "Off" })
    };
    let label = match (revision, enabled) {
        (0, _) => "Publish the flow before turning it on",
        (_, true) => "Turn the flow off",
        _ => "Turn the flow on",
    };
    let (view, id) = (view.clone(), id.to_string());
    div()
        .id("flow-revision")
        .debug_selector(move || format!("flow-revision-{}", if enabled { "on" } else { "off" }))
        .tooltip(Tooltip::text(label))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .h(px(24.0))
        .px(px(8.0))
        .rounded_full()
        .bg(fill)
        .text_step(TEXT_12)
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink)
        .when(revision > 0, |el| {
            el.cursor_pointer().on_click(move |_, _, cx| {
                let id = id.clone();
                view.update(cx, |this, cx| this.set_enabled(&id, !enabled, cx));
            })
        })
        .child(div().size(px(6.0)).rounded_full().bg(dot))
        .child(text)
        .into_any_element()
}

/// The Runs tab's label parts: its count, and how many wait for you.
fn runs_tab_badge(waiting: usize, theme: &Theme) -> Option<AnyElement> {
    (waiting > 0).then(|| {
        div()
            .debug_selector(|| "flow-waiting-badge".into())
            .flex()
            .items_center()
            .h(px(20.0))
            .px(px(8.0))
            .rounded_full()
            .bg(theme.orange_tint)
            .text_step(TEXT_11)
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.orange_ink)
            .child(format!("{waiting} waiting"))
            .into_any_element()
    })
}

impl RoutinesView {
    /// The whole column of a flow Routine's page.
    pub(crate) fn flow_column(&mut self, narrow: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_flow();
        self.sync_flow_children(window, cx);
        let theme = *cx.theme();
        let view = cx.entity();
        let (Some(routine), Some(state)) = (self.open_routine().cloned(), self.flow.as_ref()) else { return div().into_any_element() };
        let Some(info) = routine.flow.clone() else { return div().into_any_element() };
        let id = routine.id.clone();
        let trigger = trigger_kind(&routine.trigger);
        let steps = state.steps.clone();
        let (tab, mode) = (state.tab, state.mode);
        let flow_runs: Vec<&Run> = routine.runs.iter().filter(|run| run.flow.is_some()).collect();
        let waiting_runs: Vec<&Run> = flow_runs.iter().copied().filter(|run| run.flow.as_ref().is_some_and(needs_answer)).collect();
        let run = self.flow_current_run().cloned();
        let problems = flow_problems(&steps, trigger);
        let mut by_step: HashMap<String, String> = HashMap::new();
        for problem in &problems {
            if let Some(step) = &problem.step_id {
                by_step.entry(step.clone()).or_insert_with(|| problem.message.clone());
            }
        }
        let changes = flow_changes(&info.def.steps, &steps);
        let has_draft = info.revision == 0 || !changes.is_empty() || info.def.draft.is_some();
        let in_progress: Vec<&Run> = flow_runs
            .iter()
            .copied()
            .filter(|run| {
                run.flow.as_ref().is_some_and(|flow| {
                    !flow.dry_run && matches!(flow.status, FlowStatus::Running | FlowStatus::Waiting | FlowStatus::Paused)
                })
            })
            .collect();
        let page_problem = routine_problem(&routine).map(str::to_string);
        let selected = state.selected.clone();
        let error = state.error.clone();
        let computer = Self::computer_name(&routine.computer);
        let trigger_label = trigger_chip_text(&routine.trigger, Some("UTC"));
        let banner = waiting_runs
            .iter()
            .copied()
            .find(|entry| !(tab == Tab::Steps && mode == Mode::Run && run.as_ref().is_some_and(|run| run.id == entry.id)))
            .cloned();
        let created = self.created_hook.as_ref().filter(|(rid, _)| rid == &id).map(|(_, url)| url.clone());
        let two_columns = !narrow;
        let run_selected =
            run.as_ref().map(|run| state.run_steps.get(&run.id).cloned().unwrap_or_else(|| super::look::default_run_step(Some(run))));
        let (inspector, run_inspector, settings) = (state.inspector.clone(), state.run_inspector.clone(), state.settings.clone());

        // ----- the header: back, name, chips, toolbar -----
        let editing = tab == Tab::Steps && mode == Mode::Edit;
        let showing = tab == Tab::Steps && mode == Mode::Run;
        let mut toolbar = div().debug_selector(|| "flow-toolbar".into()).flex().flex_none().items_center().gap(px(8.0));
        if can_run_now(&routine) && info.revision > 0 {
            toolbar = toolbar.child(
                Button::new("flow-run-now", "Run now")
                    .variant(ButtonVariant::Secondary)
                    .icon(IconName::Play)
                    .disabled(!routine.enabled)
                    .on_click(act(&view, |this, _, cx| this.flow_run_now(cx))),
            );
        }
        toolbar = toolbar.child(revision_pill(&view, routine.enabled, info.revision, &id, &theme));
        if editing {
            let test_blocked = if steps.is_empty() {
                Some("Add at least one step to test or publish".to_string())
            } else {
                problems.first().map(|problem| problem.message.clone())
            };
            toolbar = toolbar.child(match test_blocked.clone() {
                Some(reason) => div()
                    .id("flow-test-blocked")
                    .tooltip(Tooltip::text(reason))
                    .child(Button::new("flow-test", "Test run").variant(ButtonVariant::Secondary).icon(IconName::TestTube01).disabled(true))
                    .into_any_element(),
                None => Button::new("flow-test", "Test run")
                    .variant(ButtonVariant::Secondary)
                    .icon(IconName::TestTube01)
                    .on_click(act(&view, |this, _, cx| this.flow_test_run(cx)))
                    .into_any_element(),
            });
            let publish_problem = if steps.is_empty() {
                Some("Add at least one step to test or publish".to_string())
            } else {
                problems.first().map(|problem| problem.message.clone())
            };
            let names: Vec<String> = in_progress.iter().map(|entry| run_name(&routine, entry)).collect();
            let waits = in_progress.iter().any(|entry| entry.flow.as_ref().is_some_and(needs_answer));
            toolbar = toolbar.child(publish_button(&view, info.revision, &changes, publish_problem, &names, waits, &theme));
        }
        if showing
            && let Some(run) = &run
            && let Some(flow) = &run.flow
        {
            if matches!(flow.status, FlowStatus::Running | FlowStatus::Waiting) {
                toolbar = toolbar.child(
                    Button::new("flow-pause", "Pause Run")
                        .variant(ButtonVariant::Secondary)
                        .icon(IconName::Pause)
                        .on_click(act(&view, |this, _, cx| this.flow_act(Act::Pause, cx))),
                );
            }
            if flow.status == FlowStatus::Paused {
                toolbar = toolbar.child(
                    Button::new("flow-resume", "Resume")
                        .variant(ButtonVariant::Secondary)
                        .icon(IconName::Play)
                        .on_click(act(&view, |this, _, cx| this.flow_act(Act::Resume, cx))),
                );
            }
            if matches!(flow.status, FlowStatus::Running | FlowStatus::Waiting | FlowStatus::Paused | FlowStatus::Failed) {
                toolbar = toolbar.child(end_run_button(&view, run_name(&routine, run), &theme));
            }
        }

        let title_row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(12.0))
            .mt(px(12.0))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .truncate()
                            .text_step(TEXT_22)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if routine.enabled { theme.ink } else { theme.ink2 })
                            .child(routine.name.clone()),
                    )
                    .child(
                        div()
                            .debug_selector(|| "flow-chip".into())
                            .flex()
                            .flex_none()
                            .items_center()
                            .gap(px(4.0))
                            .h(px(24.0))
                            .px(px(8.0))
                            .rounded(RADIUS_CHIP)
                            .bg(theme.accent_tint)
                            .text_step(TEXT_12)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.accent_ink)
                            .child(Icon::new(IconName::WorkflowSquare03).size(IconSize::S12).color(theme.accent_ink))
                            .child("Flow"),
                    )
                    .when(editing && info.revision > 0 && !changes.is_empty(), |el| el.child(draft_chip(&view, &changes, &theme))),
            )
            .child(toolbar);

        let subtitle = format!(
            "{}. Runs on {computer}.{}",
            trigger_sentence(&routine.trigger),
            if info.revision > 0 {
                format!(" Runs in progress keep revision {}.", info.revision)
            } else {
                " Publish it to turn it on.".to_string()
            }
        );

        // ----- tabs -----
        let tab_button = |which: Tab, id: &'static str, label: String, count: Option<usize>, badge: Option<AnyElement>| {
            let active = tab == which;
            let tab_view = view.clone();
            div()
                .id(id)
                .debug_selector(move || id.to_string())
                .relative()
                .flex()
                .items_center()
                .gap(px(4.0))
                .h(px(36.0))
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active { theme.ink } else { theme.ink2 })
                .cursor_pointer()
                .hover(move |style| style.text_color(theme.ink))
                .on_click(move |_, _, cx| tab_view.update(cx, |this, cx| this.flow_set_tab(which, cx)))
                .child(label)
                .when_some(count, |el, count| el.child(div().text_color(theme.ink3).child(count.to_string())))
                .children(badge.map(|badge| div().ml(px(4.0)).child(badge)))
                .when(active, |el| el.child(div().absolute().left_0().right_0().bottom(px(-1.0)).h(px(2.0)).rounded_full().bg(theme.ink)))
        };
        let mode_view = view.clone();
        let tabs = div()
            .flex()
            .items_end()
            .gap(px(16.0))
            .mt(px(16.0))
            .border_b_1()
            .border_color(theme.line)
            .child(
                div()
                    .debug_selector(|| "flow-tabs".into())
                    .flex()
                    .flex_1()
                    .gap(px(24.0))
                    .child(tab_button(Tab::Steps, "flow-tab-steps", "Steps".into(), None, None))
                    .child(tab_button(
                        Tab::Runs,
                        "flow-tab-runs",
                        "Runs".into(),
                        Some(routine.runs.len()),
                        runs_tab_badge(waiting_runs.len(), &theme),
                    ))
                    .child(tab_button(Tab::Settings, "flow-tab-settings", "Settings".into(), None, None)),
            )
            .when(tab == Tab::Steps, |el| {
                el.child(
                    div().flex_none().mb(px(8.0)).child(
                        Segmented::new(
                            "flow-mode",
                            Some(if mode == Mode::Edit { "edit" } else { "run" }),
                            [
                                SegmentedOption::new("edit", "Edit draft").icon(IconName::PencilEdit02),
                                SegmentedOption::new("run", "Show Run").icon(IconName::WorkflowSquare03).disabled(flow_runs.is_empty()),
                            ],
                        )
                        .on_change(move |value, _, cx| {
                            let mode = if value.as_ref() == "run" { Mode::Run } else { Mode::Edit };
                            mode_view.update(cx, |this, cx| this.flow_set_mode(mode, cx));
                        }),
                    ),
                )
            });

        // ----- banners -----
        let banner_el = banner.map(|banner| {
            let name = run_name(&routine, &banner);
            let issue = run_issue_key(&banner).map_or(String::new(), |key| format!(" ({key})"));
            let at = banner.flow.as_ref().and_then(current_step).map_or("a step".to_string(), step_title);
            let (show_view, banner_id) = (view.clone(), banner.id.clone());
            div()
                .debug_selector(|| "flow-waiting-banner".into())
                .mt(px(16.0))
                .flex()
                .items_center()
                .gap(px(12.0))
                .rounded(RADIUS_CARD)
                .bg(theme.orange_tint)
                .px(px(16.0))
                .py(px(12.0))
                .child(Icon::new(IconName::Alert02).size(IconSize::S16).color(theme.orange_ink))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_step(TEXT_13)
                        .text_color(theme.ink)
                        .child(format!("{name}{issue} is waiting for you at {at}")),
                )
                .child(
                    div()
                        .id("flow-show-waiting")
                        .debug_selector(|| "flow-show-waiting".into())
                        .flex_none()
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.orange_ink)
                        .cursor_pointer()
                        .on_click(move |_, _, cx| {
                            let banner_id = banner_id.clone();
                            show_view.update(cx, |this, cx| this.flow_show_run(&banner_id, cx));
                        })
                        .child(format!("Show {name}")),
                )
        });

        // ----- the body -----
        let trigger_card = {
            let mut card = Card::new("flow-step-trigger", None, trigger_title(&routine.trigger), format!("Trigger, {trigger_label}"));
            card.selected = selected.as_deref() == Some("trigger");
            let select_view = view.clone();
            flow_card(card, move |_, cx| select_view.update(cx, |this, cx| this.flow_select("trigger", cx)), &theme)
        };
        let columns = |left: AnyElement, right: AnyElement| -> AnyElement {
            if two_columns {
                div()
                    .flex()
                    .items_start()
                    .gap(px(24.0))
                    .child(div().flex_1().min_w_0().child(left))
                    .child(div().flex_none().w(px(INSPECTOR_WIDTH)).child(right))
                    .into_any_element()
            } else {
                div().flex().flex_col().gap(px(24.0)).child(left).child(right).into_any_element()
            }
        };
        let body: AnyElement = match tab {
            Tab::Steps if mode == Mode::Edit => {
                let left: AnyElement = if steps.is_empty() {
                    div().child(trigger_card).child(short_rail(&theme)).child(next_step_tiles(&view, &theme)).into_any_element()
                } else {
                    step_list(&view, &ListData { steps: &steps, selected: selected.as_deref(), problems: &by_step }, trigger_card, &theme)
                };
                let right: AnyElement = match (&inspector, selected.as_deref()) {
                    (Some(inspector), _) => inspector.clone().into_any_element(),
                    (None, Some("trigger")) => trigger_inspector(&view, &routine.trigger, &trigger_label, &theme),
                    _ => div().into_any_element(),
                };
                columns(left, right)
            }
            Tab::Steps => match (&run, &run_inspector) {
                (Some(run), Some(run_inspector)) => div()
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    .child(run_bar(&view, &routine, &flow_runs, run, has_draft && info.revision > 0, &theme))
                    .child(columns(
                        run_rows_view(&view, &routine, run, run_selected.as_deref(), self.now, &theme),
                        run_inspector.clone().into_any_element(),
                    ))
                    .into_any_element(),
                _ => div()
                    .debug_selector(|| "flow-no-runs".into())
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child(format!(
                        "No Runs yet. {}",
                        if info.revision == 0 {
                            "Publish the flow and turn it on, or try a Test run."
                        } else {
                            "Try a Test run to see how the draft runs."
                        }
                    ))
                    .into_any_element(),
            },
            Tab::Runs => {
                if routine.runs.is_empty() {
                    let next = routine
                        .next_run_at
                        .filter(|_| routine.enabled)
                        .map_or(String::new(), |at| format!(". Next Run {}", clock(at, &words::ZONE)));
                    div()
                        .debug_selector(|| "routine-runs-empty".into())
                        .text_step(TEXT_13)
                        .text_color(theme.ink2)
                        .child(format!("No Runs yet{next}"))
                        .into_any_element()
                } else {
                    div().debug_selector(|| "routine-runs".into()).child(self.render_runs(&routine, &routine.runs, cx)).into_any_element()
                }
            }
            Tab::Settings => settings.map_or_else(|| div().into_any_element(), |editor| editor.into_any_element()),
        };

        let page = div()
            .id("flow-page")
            .debug_selector({
                let selector = format!("routine-page-{id}");
                move || selector.clone()
            })
            .flex()
            .flex_col()
            .flex_1()
            .w_full()
            .pb(px(40.0))
            .map(|el| if narrow { el.px(px(12.0)).pt(px(16.0)) } else { el.max_w(px(PAGE_WIDTH)).px(px(24.0)).pt(px(12.0)) })
            .child(
                div().flex().child(
                    Button::new("routine-back", "Routines")
                        .variant(ButtonVariant::Quiet)
                        .size(ButtonSize::S28)
                        .icon(IconName::ArrowLeft02)
                        .on_click(act(&view, |this, _, cx| this.back(cx))),
                ),
            )
            .child(title_row)
            .child(div().debug_selector(|| "flow-subtitle".into()).mt(px(8.0)).text_step(TEXT_12).text_color(theme.ink3).child(subtitle))
            .child(tabs)
            .when_some(page_problem, |el, problem| {
                el.child(
                    div()
                        .debug_selector(|| "routine-problem".into())
                        .mt(px(16.0))
                        .flex()
                        .items_start()
                        .gap(px(8.0))
                        .rounded(RADIUS_CARD)
                        .bg(theme.red_tint)
                        .px(px(16.0))
                        .py(px(12.0))
                        .text_step(TEXT_13)
                        .text_color(theme.red_ink)
                        .child(div().mt(px(1.0)).flex_none().child(Icon::new(IconName::Alert02).size(IconSize::S16).color(theme.red_ink)))
                        .child(problem),
                )
            })
            .when_some(error, |el, error| {
                el.child(div().debug_selector(|| "flow-error".into()).mt(px(16.0)).child(InlineError::new(error).small()))
            })
            .when_some(created, |el, url| el.child(self.created_card(&url, cx)))
            .children(banner_el)
            .child(div().mt(px(20.0)).child(body));

        ScrollArea::new("flow-scroll", &self.page_scroll)
            .child(div().debug_selector(|| "flow-page".into()).w_full().flex().flex_1().justify_center().child(page))
            .into_any_element()
    }
}

//! The Subagents pill and panel (`SubagentTrack.tsx`): a "Subagents n" pill that grows into the list, each row
//! with its status, title, elapsed time, what it says now (or its outcome) and how far it got; Archive finished and
//! the Archived list; and one subagent's detail (its plan or, without one, what it said step by step, what it does
//! now, its Result, Task and the Full log).
//!
//! Not built: the QA persona avatars and fleet header, advisor Stop and Retry, markdown in the Result and the log,
//! the keyboard walk through rows.

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, FontWeight, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*, px,
};

use super::data::{AgentStatus, Subagent};
use super::{HEADER, PANEL_PAD, PillRow, collapse_button, panel_header, scroll_body};
use crate::data::Provider;
use crate::logic::activity::subagent_glance::{ToolCategory, tool_chips, tool_summary};
use crate::logic::activity::subchat_states::format_elapsed;
use crate::logic::plan::TaskStatus;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, RADIUS_INLINE, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, EmptySize, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize, ProviderLogo,
    SectionLabel, Spinner, StatusPill,
};

const ROW_HEIGHT: f32 = 78.0;
const FOOTER: f32 = 36.0;

/// How the list is split: what shows under the toggle, and the counts the header names.
pub struct Listing<'a> {
    pub rows: Vec<&'a Subagent>,
    pub visible: usize,
    pub running: usize,
    pub done: usize,
    pub archived: usize,
}

pub fn listing(agents: &[Subagent], archived_view: bool) -> Listing<'_> {
    let visible = agents.iter().filter(|agent| !agent.archived).count();
    Listing {
        rows: agents.iter().filter(|agent| agent.archived == archived_view).collect(),
        visible,
        running: agents.iter().filter(|agent| !agent.archived && agent.status.active()).count(),
        done: agents.iter().filter(|agent| !agent.archived && agent.status.finished()).count(),
        archived: agents.len() - visible,
    }
}

fn elapsed(agent: &Subagent, now: i64) -> String {
    format_elapsed(agent.ended_at.unwrap_or(now) - agent.started_at)
}

/// The one line under a row's title: what it says now, or, when finished, how it ended.
pub fn line(agent: &Subagent) -> String {
    let fallback = agent.status.label();
    if agent.status.active() {
        agent.said.clone().unwrap_or_else(|| fallback.into())
    } else {
        agent.outcome.clone().or_else(|| agent.said.clone()).unwrap_or_else(|| fallback.into())
    }
}

/// "2 of 3 · 6 reads · Explorer": how far it got.
pub fn meta(agent: &Subagent) -> String {
    let done = agent.tasks.iter().filter(|task| task.status == TaskStatus::Completed).count();
    let progress = if !agent.tasks.is_empty() {
        format!("{done} of {}", agent.tasks.len())
    } else if agent.steps > 0 {
        format!("Step {}", agent.steps)
    } else {
        String::new()
    };
    [progress, tool_summary(&agent.tools, 2), agent.role.clone().unwrap_or_default()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

impl PillRow {
    pub(super) fn subagents_pill(&self, cx: &mut Context<Self>) -> StatusPill {
        let list = listing(&self.data.subagents, false);
        let theme = *cx.theme();
        let pill = StatusPill::new("pill-subagents-button")
            .label("Subagents")
            .count(list.visible as u32)
            .gap(8.0)
            .bare()
            .tooltip("Subagents")
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.set_open(Some(super::Kind::Subagents), false, window, cx)));
        if list.running > 0 { pill.leading(Spinner::new("subagents-pill-spinner").color(theme.ink3), 12.0) } else { pill }
    }

    pub(super) fn subagents_height(&self) -> f32 {
        if self.detail() {
            return 600.0;
        }
        let list = listing(&self.data.subagents, self.show_archived);
        2.0 * PANEL_PAD + HEADER + list.rows.len().max(1) as f32 * ROW_HEIGHT + FOOTER + 4.0
    }

    pub fn select_agent(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.selected_agent = id;
        self.log_open = false;
        cx.notify();
    }

    pub fn selected_agent(&self) -> Option<&str> {
        self.selected_agent.as_deref()
    }

    /// Archive or restore one subagent.
    pub fn archive_agent(&mut self, id: &str, archived: bool, cx: &mut Context<Self>) {
        if let Some(agent) = self.data.subagents.iter_mut().find(|agent| agent.id == id) {
            agent.archived = archived;
        }
        cx.notify();
    }

    /// "Archive finished": every finished, unarchived subagent.
    pub fn archive_finished(&mut self, cx: &mut Context<Self>) {
        for agent in self.data.subagents.iter_mut().filter(|agent| agent.status.finished()) {
            agent.archived = true;
        }
        cx.notify();
    }

    pub fn set_archived_view(&mut self, shown: bool, cx: &mut Context<Self>) {
        self.show_archived = shown;
        cx.notify();
    }

    pub(super) fn subagents_panel(&mut self, size: (f32, f32), _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let now = self.data.now;
        let body = match self.selected_agent.as_deref().and_then(|id| self.data.subagents.iter().find(|agent| agent.id == id)).cloned() {
            Some(agent) => self.subagent_detail(&agent, now, &theme, cx),
            None => self.subagent_list(now, &theme, cx),
        };
        div()
            .id("panel-subagents")
            .debug_selector(|| "panel-subagents".into())
            .size_full()
            .flex()
            .flex_col()
            .p(px(PANEL_PAD))
            .child(body)
            .w(px(size.0))
            .into_any_element()
    }

    fn subagent_list(&mut self, now: i64, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let archived_view = self.show_archived;
        let list = listing(&self.data.subagents, archived_view);
        let trailing = if archived_view {
            String::new()
        } else {
            [(list.running > 0).then(|| format!("{} running", list.running)), (list.done > 0).then(|| format!("{} done", list.done))]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" \u{b7} ")
        };
        let rows: Vec<AnyElement> = list.rows.iter().map(|agent| agent_row(agent, now, archived_view, !self.live, &theme, cx)).collect();
        let empty = rows.is_empty();
        let can_archive = self.data.subagents.iter().any(|agent| agent.status.finished() && !agent.archived);
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(panel_header(
                if archived_view { "Archived" } else { "Subagents" },
                trailing,
                collapse_button("subagents-collapse", cx),
                &theme,
            ))
            .child(scroll_body("subagents-body", &self.scroll, rows))
            .when(empty, |el| {
                el.child(EmptyState::new().size(EmptySize::Compact).title(if archived_view {
                    "No archived subagents"
                } else {
                    "No subagents to show"
                }))
            })
            .child(div().flex_none().flex().items_center().gap_1().mt_1().pt_1().border_t_1().border_color(theme.line).child(
                if archived_view {
                    Button::new("subagent-archived-toggle", "Back to subagents")
                        .icon(IconName::ArrowLeft01)
                        .variant(ButtonVariant::Quiet)
                        .size(ButtonSize::S24)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_archived_view(false, cx)))
                        .into_any_element()
                } else {
                    div()
                        .flex()
                        .items_center()
                        .gap_1()
                        .when(!self.live, |el| {
                            el.child(
                                Button::new("subagent-archive-finished", "Archive finished")
                                    .icon(IconName::Archive02)
                                    .variant(ButtonVariant::Quiet)
                                    .size(ButtonSize::S24)
                                    .disabled(!can_archive)
                                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.archive_finished(cx))),
                            )
                        })
                        .when(list.archived > 0, |el| {
                            el.child(
                                Button::new("subagent-archived-toggle", format!("Archived ({})", list.archived))
                                    .variant(ButtonVariant::Quiet)
                                    .size(ButtonSize::S24)
                                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.set_archived_view(true, cx))),
                            )
                        })
                        .into_any_element()
                },
            ))
            .into_any_element()
    }

    fn subagent_detail(&mut self, agent: &Subagent, now: i64, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let running = agent.status.active();
        let current = agent.transcript.last().cloned();
        let said = agent.said.clone().or_else(|| current.as_ref().map(|step| step.said.clone()).filter(|said| !said.is_empty()));
        let tool =
            running.then(|| agent.latest_tool.clone().or_else(|| current.as_ref().and_then(|step| step.last_tool.clone()))).flatten();
        let totals = tool_summary(&agent.tools, 2);
        let mut sections: Vec<AnyElement> = Vec::new();
        sections.push(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_x_3()
                .gap_y_1()
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(div().text_color(theme.ink2).child(agent.status.label()))
                .child(elapsed(agent, now))
                .children(agent.role.clone())
                .children(agent.model.clone())
                .into_any_element(),
        );
        if !agent.tasks.is_empty() {
            let done = agent.tasks.iter().filter(|task| task.status == TaskStatus::Completed).count();
            let now_line = [tool.clone(), running.then(|| (!totals.is_empty()).then(|| format!("{totals} so far"))).flatten()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" \u{b7} ");
            sections.push(
                div()
                    .debug_selector(|| "subagent-plan".into())
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .px_1p5()
                            .pb_1()
                            .child(SectionLabel::new("Plan"))
                            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(format!("{done} of {} done", agent.tasks.len()))),
                    )
                    .children(agent.tasks.iter().enumerate().map(|(index, task)| {
                        let doing = task.status == TaskStatus::InProgress;
                        div()
                            .flex()
                            .flex_col()
                            .gap_1p5()
                            .p_1p5()
                            .rounded(RADIUS_CONTROL)
                            .text_step(TEXT_13)
                            .border_1()
                            .border_color(gpui::transparent_black())
                            .when(doing, |el| el.bg(theme.hover).border_color(theme.line_strong))
                            .child(
                                div()
                                    .flex()
                                    .items_start()
                                    .gap_2()
                                    .child(step_number(index + 1, doing, &theme))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .text_color(match task.status {
                                                TaskStatus::Completed => theme.ink3,
                                                TaskStatus::InProgress => theme.ink,
                                                TaskStatus::Pending => theme.ink2,
                                            })
                                            .when(doing, |el| el.font_weight(FontWeight::MEDIUM))
                                            .child(if doing {
                                                task.active_form.clone().unwrap_or_else(|| task.content.clone())
                                            } else {
                                                task.content.clone()
                                            }),
                                    )
                                    .child(task_marker(&task.id, task.status, &theme)),
                            )
                            .when(doing && (said.is_some() || !now_line.is_empty()), |el| {
                                el.child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap_0p5()
                                        .pl(px(24.0))
                                        .children(said.clone().map(|said| div().text_step(TEXT_13).text_color(theme.ink2).child(said)))
                                        .when(!now_line.is_empty(), |el| {
                                            el.child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(now_line.clone()))
                                        }),
                                )
                            })
                    }))
                    .into_any_element(),
            );
        } else {
            if running && let Some(step) = &current {
                sections.push(
                    div()
                        .debug_selector(|| "subagent-now".into())
                        .flex()
                        .flex_col()
                        .gap_1p5()
                        .p_3()
                        .rounded(RADIUS_CARD)
                        .bg(theme.hover)
                        .border_1()
                        .border_color(theme.line_strong)
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_1p5()
                                .child(Spinner::new("subagent-now-spinner"))
                                .child(SectionLabel::new(format!("Now \u{b7} step {}", agent.transcript.len()))),
                        )
                        .child(
                            div().text_step(TEXT_15).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(if step.said.is_empty() {
                                agent.status.label().to_string()
                            } else {
                                step.said.clone()
                            }),
                        )
                        .children(tool.clone().map(|tool| div().truncate().text_step(TEXT_12).text_color(theme.ink3).child(tool)))
                        .into_any_element(),
                );
            }
            let earlier: Vec<_> = if running {
                agent.transcript.iter().take(agent.transcript.len().saturating_sub(1)).collect()
            } else {
                agent.transcript.iter().collect()
            };
            if !earlier.is_empty() {
                sections.push(
                    div()
                        .debug_selector(|| "subagent-steps".into())
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .child(div().px_1p5().pb_1().child(SectionLabel::new(if running { "Earlier" } else { "Steps" })))
                        .children(earlier.iter().enumerate().map(|(index, step)| {
                            div()
                                .flex()
                                .items_start()
                                .gap_2()
                                .p_1p5()
                                .text_step(TEXT_13)
                                .child(step_number(index + 1, false, &theme))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .flex()
                                        .flex_col()
                                        .gap_1()
                                        .child(div().line_clamp(2).text_color(theme.ink3).child(if step.said.is_empty() {
                                            "Getting started".to_string()
                                        } else {
                                            step.said.clone()
                                        }))
                                        .child(tool_chip_row(&step.tools, &theme)),
                                )
                        }))
                        .into_any_element(),
                );
            }
        }
        if !running && let Some(result) = &agent.result {
            sections.push(
                div()
                    .debug_selector(|| "subagent-result".into())
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(SectionLabel::new("Result"))
                    .child(self.clamped("result", 6, result.clone(), &theme, cx))
                    .into_any_element(),
            );
        }
        if let Some(prompt) = &agent.prompt {
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(SectionLabel::new("Task"))
                    .child(self.clamped("task", 2, prompt.clone(), &theme, cx))
                    .into_any_element(),
            );
        }
        if !agent.transcript.is_empty() || agent.tasks.is_empty() && !running {
            let open = self.log_open;
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(
                        div()
                            .id("subagent-log-toggle")
                            .debug_selector(|| "subagent-log-toggle".into())
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .self_start()
                            .text_step(TEXT_11)
                            .text_color(theme.ink3)
                            .cursor_pointer()
                            .hover(move |style| style.text_color(theme.ink))
                            .child(Icon::new(IconName::Scroll).size(IconSize::S12).color(theme.ink3))
                            .child(if open {
                                "Hide full log".to_string()
                            } else {
                                format!("Full log ({} entries)", agent.transcript.len())
                            })
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                this.log_open = !this.log_open;
                                cx.notify();
                            })),
                    )
                    .when(open, |el| {
                        el.children(agent.transcript.iter().map(|step| {
                            div().min_w_0().text_step(TEXT_13).child(if step.text.is_empty() {
                                "(no words)".to_string()
                            } else {
                                step.text.clone()
                            })
                        }))
                    })
                    .into_any_element(),
            );
        }
        let title = agent.title.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_1p5()
                    .py_1p5()
                    .border_b_1()
                    .border_color(theme.line)
                    .child(
                        IconButton::new("subagent-back", IconName::ArrowLeft01)
                            .size(IconButtonSize::S24)
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.select_agent(None, cx))),
                    )
                    .child(div().flex_1().min_w_0().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child(title))
                    .child(collapse_button("subagents-collapse", cx)),
            )
            .child(scroll_body(
                "subagent-detail",
                &self.scroll,
                vec![
                    div()
                        .flex()
                        .flex_col()
                        .gap_4()
                        .p_3()
                        .debug_selector(|| "subagent-transcript".into())
                        .children(sections)
                        .into_any_element(),
                ],
            ))
            .into_any_element()
    }

    /// Text clamped to a few lines, with Show all when it does not fit (judged by line count here, not measured).
    fn clamped(&self, name: &'static str, lines: usize, text: String, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let open = self.clamped.contains(name);
        // A line is about 52 characters at this width; more lines than that clip.
        let clipped = text.lines().map(|line| line.chars().count().div_ceil(52).max(1)).sum::<usize>() > lines;
        div()
            .flex()
            .flex_col()
            .items_start()
            .gap_1()
            .child(
                div().self_stretch().min_w_0().text_step(TEXT_13).text_color(theme.ink2).when(!open, |el| el.line_clamp(lines)).child(text),
            )
            .when(clipped || open, |el| {
                el.child(
                    div()
                        .id(ElementId::from(SharedString::from(format!("show-all-{name}"))))
                        .debug_selector(move || format!("show-all-{name}"))
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .cursor_pointer()
                        .hover(move |style| style.text_color(theme.ink))
                        .child(if open { "Show less" } else { "Show all" })
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            if !this.clamped.remove(name) {
                                this.clamped.insert(name);
                            }
                            cx.notify();
                        })),
                )
            })
            .into_any_element()
    }
}

fn step_number(value: usize, current: bool, theme: &Theme) -> AnyElement {
    div()
        .mt_0p5()
        .flex_none()
        .min_w(px(16.0))
        .px_1()
        .rounded(RADIUS_INLINE)
        .flex()
        .justify_center()
        .text_step(TEXT_11)
        .bg(if current { theme.hover2 } else { theme.hover })
        .text_color(if current { theme.ink2 } else { theme.ink3 })
        .child(value.to_string())
        .into_any_element()
}

fn task_marker(id: &str, status: TaskStatus, theme: &Theme) -> AnyElement {
    let slot = div().mt_0p5().flex().flex_none().items_center().justify_center().size(px(16.0));
    match status {
        TaskStatus::InProgress => slot.child(Spinner::new(SharedString::from(format!("agent-task-spinner-{id}")))).into_any_element(),
        TaskStatus::Completed => slot.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink3)).into_any_element(),
        TaskStatus::Pending => {
            slot.child(div().size(px(12.0)).rounded_full().border(px(1.5)).border_color(theme.line_strong)).into_any_element()
        }
    }
}

fn chip_icon(category: ToolCategory) -> IconName {
    match category {
        ToolCategory::Commands => IconName::CommandLine,
        ToolCategory::Images => IconName::Image01,
        ToolCategory::Reads => IconName::File01,
        ToolCategory::Searches => IconName::Search01,
        ToolCategory::Edits => IconName::PencilEdit02,
        ToolCategory::Other => IconName::Wrench01,
    }
}

fn tool_chip_row(counts: &crate::logic::activity::subagent_glance::ToolCounts, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .flex_wrap()
        .gap_1()
        .children(tool_chips(counts).into_iter().map(|chip| {
            div()
                .flex()
                .items_center()
                .gap_1()
                .px_1()
                .py_0p5()
                .rounded(RADIUS_INLINE)
                .bg(theme.hover)
                .text_step(crate::theme::TEXT_10)
                .text_color(theme.ink3)
                .child(Icon::new(chip_icon(chip.category)).size(IconSize::S12).color(theme.ink3))
                .child(chip.label)
        }))
        .into_any_element()
}

fn agent_row(agent: &Subagent, now: i64, archived_view: bool, can_archive: bool, theme: &Theme, cx: &mut Context<PillRow>) -> AnyElement {
    let theme = *theme;
    let id = agent.id.clone();
    let open_id = id.clone();
    let archive_id = id.clone();
    let running = agent.status.active();
    let mark = if running {
        Spinner::new(SharedString::from(format!("agent-row-spinner-{}", agent.id))).into_any_element()
    } else if agent.status == AgentStatus::Failed {
        Icon::new(IconName::AlertCircle).size(IconSize::S14).color(theme.ink3).into_any_element()
    } else {
        ProviderLogo::new(Provider::Claude).size(14.0).into_any_element()
    };
    let meta = meta(agent);
    let selector = format!("subagent-row-{}", agent.id);
    div()
        .id(ElementId::from(SharedString::from(format!("subagent-li-{}", agent.id))))
        .debug_selector(move || selector.clone())
        .group("subagent-row")
        .flex_none()
        .flex()
        .items_start()
        .gap_1()
        .px_1()
        .rounded(RADIUS_CONTROL)
        .hover(move |style| style.bg(theme.hover))
        .child(
            div()
                .id(ElementId::from(SharedString::from(format!("subagent-open-{}", agent.id))))
                .debug_selector({
                    let id = agent.id.clone();
                    move || format!("subagent-open-{id}")
                })
                .flex_1()
                .min_w_0()
                .flex()
                .items_start()
                .gap_2()
                .py_2()
                .pl_1()
                .text_step(TEXT_13)
                .cursor_pointer()
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select_agent(Some(open_id.clone()), cx)))
                .child(div().mt_0p5().flex().flex_none().items_center().justify_center().size(px(16.0)).child(mark))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap_0p5()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .truncate()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(if running { theme.ink } else { theme.ink2 })
                                        .child(agent.title.clone()),
                                )
                                .child(div().flex_none().text_step(TEXT_11).text_color(theme.ink3).child(elapsed(agent, now))),
                        )
                        .child(div().line_clamp(2).text_color(if running { theme.ink2 } else { theme.ink3 }).child(line(agent)))
                        .when(!meta.is_empty(), |el| el.child(div().truncate().text_step(TEXT_11).text_color(theme.ink3).child(meta))),
                ),
        )
        .when(can_archive, |el| {
            el.child(
                div().flex_none().pt(px(6.0)).opacity(0.0).group_hover("subagent-row", |style| style.opacity(1.0)).child(
                    IconButton::new(ElementId::from(SharedString::from(format!("subagent-archive-{}", agent.id))), IconName::Archive02)
                        .size(IconButtonSize::S24)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.archive_agent(&archive_id, !archived_view, cx))),
                ),
            )
        })
        .into_any_element()
}

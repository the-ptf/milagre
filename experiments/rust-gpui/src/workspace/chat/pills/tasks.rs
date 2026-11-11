//! The Tasks pill and panel (`TaskTrack.tsx`): a "done/total" pill that grows into the Chat's task tree and its phase
//! graph. A pill without tasks (only phases) says the current phase instead.

use std::collections::HashSet;

use gpui::{AnyElement, ClickEvent, Context, ElementId, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::{HEADER, PANEL_PAD, PillRow, collapse_button, panel_header, phase, scroll_body};
use crate::logic::plan::{ChatTask, TaskStatus, current_phase, task_counts};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, RADIUS_INLINE, TEXT_11, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, SpinnerRing, StatusPill};

/// One drawn row of the tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskLine {
    pub id: String,
    pub depth: usize,
    /// 1-based position among its siblings.
    pub number: usize,
    /// What the row says: a leaf in progress says what it is doing now.
    pub text: String,
    pub status: TaskStatus,
    pub parent: bool,
    pub open: bool,
}

/// The rows the tree shows, folded parents hiding their children (`TaskRows`).
pub fn visible_rows(tasks: &[ChatTask], folded: &HashSet<String>) -> Vec<TaskLine> {
    fn walk(tasks: &[ChatTask], depth: usize, folded: &HashSet<String>, out: &mut Vec<TaskLine>) {
        for (index, task) in tasks.iter().enumerate() {
            let parent = !task.children.is_empty();
            let open = parent && !folded.contains(&task.id);
            let doing = task.status == TaskStatus::InProgress && !parent;
            out.push(TaskLine {
                id: task.id.clone(),
                depth,
                number: index + 1,
                text: if doing { task.active_form.clone().unwrap_or_else(|| task.title.clone()) } else { task.title.clone() },
                status: task.status,
                parent,
                open,
            });
            if open {
                walk(&task.children, depth + 1, folded, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(tasks, 0, folded, &mut out);
    out
}

const ROW_HEIGHT: f32 = 30.0;

impl PillRow {
    pub(super) fn tasks_pill_text(&self) -> String {
        let Some(plan) = &self.data.plan else { return String::new() };
        let (done, total) = task_counts(&plan.tasks);
        if total > 0 { format!("{done}/{total}") } else { current_phase(plan).map(|phase| phase.label().to_string()).unwrap_or_default() }
    }

    pub(super) fn tasks_pill(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(plan) = &self.data.plan else { return div().into_any_element() };
        let (done, total) = task_counts(&plan.tasks);
        let mut pill = StatusPill::new("pill-tasks-button").icon(IconName::ListTodo).bare();
        pill = if total > 0 { pill.count(done as u32).total(total as u32) } else { pill.label(self.tasks_pill_text()) };
        pill.on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.set_open(Some(super::Kind::Tasks), false, window, cx)))
            .into_any_element()
    }

    pub(super) fn tasks_height(&self) -> f32 {
        let Some(plan) = &self.data.plan else { return 0.0 };
        let rows = visible_rows(&plan.tasks, &self.folded).len() as f32;
        let header = if plan.tasks.is_empty() { 0.0 } else { HEADER };
        let graph = if plan.phases.is_empty() { 0.0 } else { phase::SECTION_HEIGHT };
        2.0 * PANEL_PAD + header + rows * ROW_HEIGHT + graph
    }

    pub(super) fn tasks_panel(&mut self, size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let Some(plan) = self.data.plan.clone() else { return div().into_any_element() };
        let (_, total) = task_counts(&plan.tasks);
        let lines = visible_rows(&plan.tasks, &self.folded);
        let mut body: Vec<AnyElement> = Vec::new();
        if !lines.is_empty() {
            body.push(div().flex_none().flex().flex_col().children(lines.iter().map(|line| task_row(line, &theme, cx))).into_any_element());
        }
        // Without tasks the graph's own header carries the collapse button.
        let action = plan.tasks.is_empty().then(|| collapse_button("tasks-collapse", cx));
        if let Some(graph) = phase::phase_graph_section(&plan, self.data.now, size.0, &theme, action) {
            body.push(graph);
        }
        div()
            .id("panel-tasks")
            .debug_selector(|| "panel-tasks".into())
            .size_full()
            .flex()
            .flex_col()
            .gap_1()
            .p(px(PANEL_PAD))
            .when(!plan.tasks.is_empty(), |el| {
                el.child(panel_header("Tasks", total.to_string(), collapse_button("tasks-collapse", cx), &theme))
            })
            .child(scroll_body("task-body", &self.scroll, body))
            .into_any_element()
    }

    /// A parent's chevron: fold or unfold its children.
    pub fn toggle_fold(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.folded.remove(id) {
            self.folded.insert(id.to_string());
        }
        cx.notify();
    }

    pub fn folded(&self) -> &HashSet<String> {
        &self.folded
    }
}

fn marker(status: TaskStatus, theme: &Theme) -> AnyElement {
    let slot = div().mt_0p5().flex().flex_none().items_center().justify_center().size(px(16.0));
    match status {
        TaskStatus::InProgress => slot.child(SpinnerRing::new().size(12.0)).into_any_element(),
        TaskStatus::Completed => slot.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.ink3)).into_any_element(),
        TaskStatus::Pending => {
            slot.child(div().size(px(12.0)).rounded_full().border(px(1.5)).border_color(theme.line_strong)).into_any_element()
        }
    }
}

fn task_row(line: &TaskLine, theme: &Theme, cx: &mut Context<PillRow>) -> AnyElement {
    let doing = line.status == TaskStatus::InProgress && !line.parent;
    let id = line.id.clone();
    let selector = format!("task-row-{}", line.id);
    div()
        .id(ElementId::from(SharedString::from(selector.clone())))
        .debug_selector(move || selector.clone())
        .flex_none()
        .flex()
        .items_start()
        .gap_2()
        .pl(px(8.0 + line.depth as f32 * 16.0))
        .pr_2()
        .py(px(5.0))
        .rounded(RADIUS_CONTROL)
        .text_step(TEXT_13)
        .border_1()
        .border_color(gpui::transparent_black())
        .when(doing, |el| el.bg(theme.hover).border_color(gpui::Hsla::from(theme.accent).opacity(0.5)))
        .child(if line.parent {
            div()
                .id(ElementId::from(SharedString::from(format!("task-fold-{}", line.id))))
                .debug_selector({
                    let id = line.id.clone();
                    move || format!("task-fold-{id}")
                })
                .mt_0p5()
                .flex_none()
                .size(px(12.0))
                .cursor_pointer()
                .child(
                    Icon::new(if line.open { IconName::ArrowDown01 } else { IconName::ArrowRight01 }).size(IconSize::S12).color(theme.ink3),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_fold(&id, cx)))
                .into_any_element()
        } else {
            div().flex_none().w(px(12.0)).into_any_element()
        })
        .child(
            div()
                .mt_0p5()
                .flex_none()
                .min_w(px(16.0))
                .px_1()
                .rounded(RADIUS_INLINE)
                .bg(theme.hover)
                .flex()
                .justify_center()
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child(line.number.to_string()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_color(if line.status == TaskStatus::Completed && !line.parent { theme.ink3 } else { theme.ink })
                .font_weight(FontWeight::NORMAL)
                .child(line.text.clone()),
        )
        .child(marker(line.status, theme))
        .into_any_element()
}

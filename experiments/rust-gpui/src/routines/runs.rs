//! A Routine's Runs, newest first (R-03: `RunList.tsx`): grouped by day under small headings (Today, Yesterday, Thu,
//! Oct 16). A Run that did something has a row; a stretch of Runs that didn't (quiet, skipped, missed, refused) folds
//! into one line that expands in place. Days before yesterday show one summary line until opened. Show earlier days adds
//! day groups. A row opens the Run's Chat beside the page when it can; the open one is highlighted.

use gpui::{AnyElement, App, Context, ElementId, FontWeight, Rgba, SharedString, Window, div, prelude::*, px};

use super::model::{Routine, Run, RunStatus};
use super::words::{
    self, Fold, RunEntry, attempt_text, clock, day_summary, first_line, fold_text, fold_times, retry_note, run_days, run_title,
};
use super::{RoutinesView, list::act};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, SectionLabel, SpinnerRing};

/// Day groups shown at first, and how many more each Show earlier days adds.
pub(crate) const FIRST_DAYS: usize = 4;
const MORE_DAYS: usize = 7;
type Handler = std::rc::Rc<dyn Fn(&mut Window, &mut App)>;
const ROW_HEIGHT: f32 = 36.0;
const TIME_WIDTH: f32 = 84.0;

/// A Run that did something: its icon and tone, and the words its row shows (a failed one says why, in red).
struct Look {
    icon: IconName,
    spin: bool,
    red: bool,
    orange: bool,
    text: String,
    failed: bool,
}

fn run_look(run: &Run, routine_name: &str) -> Look {
    // A flow Run says where it stands: "MIL-482 Retry webhooks \u{b7} Waiting for you at Open pull request".
    if let Some(flow) = &run.flow {
        use super::flows::ops::{flow_run_text, needs_answer};
        use super::flows::types::FlowStatus;
        let text = format!("{} \u{b7} {}", run_title(run, routine_name), flow_run_text(flow, run.error.as_deref()));
        let look = |icon, spin, red, orange, failed| Look { icon, spin, red, orange, text: text.clone(), failed };
        return match flow.status {
            FlowStatus::Running => look(IconName::Loading03, true, false, false, false),
            FlowStatus::Waiting if needs_answer(flow) => look(IconName::PauseCircle, false, false, true, false),
            FlowStatus::Waiting => look(IconName::Clock01, false, false, false, false),
            FlowStatus::Paused => look(IconName::Pause, false, false, false, false),
            FlowStatus::Failed => look(IconName::Alert02, false, true, false, true),
            FlowStatus::Ended => look(IconName::MinusSignCircle, false, false, false, false),
            FlowStatus::Done => look(IconName::CheckmarkCircle02, false, false, false, false),
        };
    }
    // A Run that ran on its fallback says so after its words.
    let note = retry_note(run);
    let noted = |text: String| if note.is_empty() { text } else { format!("{text} \u{b7} {note}") };
    match run.status {
        RunStatus::Ended => {
            let text = match first_line(run.error.as_deref()) {
                Some(reason) => format!("Ended, {reason}"),
                None => "Ended".into(),
            };
            Look { icon: IconName::MinusSignCircle, spin: false, red: false, orange: false, text: noted(text), failed: false }
        }
        RunStatus::Running => Look {
            icon: IconName::Loading03,
            spin: true,
            red: false,
            orange: false,
            text: noted(run_title(run, routine_name)),
            failed: false,
        },
        RunStatus::Failed => {
            let text = match first_line(run.error.as_deref()) {
                Some(error) => format!("Failed: {error}"),
                None => "Failed".into(),
            };
            Look { icon: IconName::Alert02, spin: false, red: true, orange: false, text: noted(text), failed: true }
        }
        _ => Look {
            icon: IconName::CheckmarkCircle02,
            spin: false,
            red: false,
            orange: false,
            text: noted(run_title(run, routine_name)),
            failed: false,
        },
    }
}

/// A folded Run as its line says it.
fn folded_line(run: &Run) -> (IconName, String) {
    if run.rejected {
        return (IconName::Unavailable, first_line(run.error.as_deref()).unwrap_or_else(|| "Refused".into()));
    }
    match run.status {
        RunStatus::Quiet => {
            let note = retry_note(run);
            let text = run.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("Quiet").to_string();
            (IconName::Moon02, if note.is_empty() { text } else { format!("{text} \u{b7} {note}") })
        }
        RunStatus::SkippedBusy => (IconName::Next, "Its Chat was busy".into()),
        _ => (IconName::Clock01, "This Mac missed its time".into()),
    }
}

/// One line of the log, 36px: the time column, an icon, the words, then an unread dot and a chevron when it opens a Chat.
struct Row {
    id: SharedString,
    time: String,
    icon: IconName,
    spin: bool,
    text: String,
    muted: bool,
    red: bool,
    orange: bool,
    unread: bool,
    selected: bool,
    trailing: Option<IconName>,
    on_click: Option<Handler>,
}

impl Row {
    fn new(id: impl Into<SharedString>, time: impl Into<String>, icon: IconName, text: impl Into<String>) -> Self {
        Row {
            id: id.into(),
            time: time.into(),
            icon,
            spin: false,
            text: text.into(),
            muted: false,
            red: false,
            orange: false,
            unread: false,
            selected: false,
            trailing: None,
            on_click: None,
        }
    }

    fn render(self, cx: &App) -> AnyElement {
        let theme = *cx.theme();
        let tone: Rgba = if self.red {
            theme.red_ink
        } else if self.orange {
            theme.orange_ink
        } else {
            theme.ink3
        };
        let selector = self.id.to_string();
        let text_color = if self.red {
            theme.red_ink
        } else if self.muted {
            theme.ink2
        } else {
            theme.ink
        };
        let (hover, hover2) = (theme.hover, theme.hover2);
        div()
            .id(ElementId::from(self.id))
            .debug_selector(move || selector.clone())
            .flex()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .h(px(ROW_HEIGHT))
            .px(px(8.0))
            .rounded(RADIUS_CONTROL)
            .when(self.selected, |el| el.bg(theme.hover2))
            .when_some(self.on_click, |el, click| {
                el.cursor_pointer()
                    .hover(move |style| style.bg(hover))
                    .active(move |style| style.bg(hover2))
                    .on_click(move |_, window, cx| click(window, cx))
            })
            .child(div().flex_none().w(px(TIME_WIDTH)).text_step(TEXT_12).text_color(theme.ink3).child(self.time))
            .child(div().flex().flex_none().items_center().justify_center().size(px(20.0)).child(if self.spin {
                SpinnerRing::new().size(14.0).color(tone).into_any_element()
            } else {
                Icon::new(self.icon).size(IconSize::S14).color(tone).into_any_element()
            }))
            .child({
                let mut text = div().flex_1().min_w_0().truncate().text_step(TEXT_13).text_color(text_color).child(self.text);
                if !self.muted && !self.red {
                    text = text.font_weight(FontWeight::MEDIUM);
                }
                text
            })
            .when(self.unread, |el| {
                el.child(div().debug_selector(|| "run-unread".into()).flex_none().size(px(8.0)).rounded_full().bg(theme.accent))
            })
            .children(self.trailing.map(|icon| Icon::new(icon).size(IconSize::S14).color(theme.ink3)))
            .into_any_element()
    }
}

impl RoutinesView {
    /// The Runs list of `routine` (already filtered to `runs`).
    pub(crate) fn render_runs(&self, routine: &Routine, runs: &[Run], cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let days = run_days(runs, self.now, &words::ZONE);
        let selected = self.run_chat.as_ref().map(|chat| chat.key.clone());
        let name = routine.name.clone();
        let count = days.len();

        let open_chat = |chat: &str| {
            let (view, chat) = (view.clone(), chat.to_string());
            let on: Handler = std::rc::Rc::new(move |window, cx| {
                let chat = chat.clone();
                view.update(cx, |this, cx| this.open_run_chat(&chat, window, cx));
            });
            on
        };
        let show_flow_run = |id: String| {
            let view = view.clone();
            let on: Handler = std::rc::Rc::new(move |_, cx| {
                let id = id.clone();
                view.update(cx, |this, cx| this.flow_show_run(&id, cx));
            });
            on
        };
        let toggle = |key: String| {
            let view = view.clone();
            let on: Handler = std::rc::Rc::new(move |_, cx| {
                let key = key.clone();
                view.update(cx, |this, cx| {
                    if !this.expanded.remove(&key) {
                        this.expanded.insert(key);
                    }
                    cx.notify();
                });
            });
            on
        };

        // The attempts a Run retried after, each a muted line under it that opens its own Chat while it is there.
        let attempts = |run: &Run| -> Vec<AnyElement> {
            run.attempts
                .iter()
                .map(|attempt| {
                    let chat = attempt.chat_id.as_deref().filter(|chat| self.can_open(chat));
                    let mut row = Row::new(
                        format!("routine-run-attempt-{}-{}", run.id, attempt.ended_at),
                        "",
                        IconName::Alert02,
                        attempt_text(attempt.model.as_deref(), attempt.effort.as_deref(), attempt.error.as_deref()),
                    );
                    row.muted = true;
                    row.selected = chat.is_some() && chat.map(str::to_string) == selected;
                    if let Some(chat) = chat {
                        row.trailing = Some(IconName::ArrowRight01);
                        row.on_click = Some(open_chat(chat));
                    }
                    row.render(cx)
                })
                .collect()
        };

        let entry = |item: &RunEntry| -> AnyElement {
            match item {
                RunEntry::Run(run) => {
                    let look = run_look(run, &name);
                    let chat = run.chat_id.as_deref().filter(|chat| self.can_open(chat));
                    let mut row = Row::new(format!("routine-run-{}", run.id), clock(run.started_at, &words::ZONE), look.icon, look.text);
                    row.spin = look.spin;
                    row.red = look.red && look.failed;
                    row.orange = look.orange;
                    // A flow Run opens its Run view; the other Runs their Chat.
                    let chat = chat.filter(|_| run.flow.is_none());
                    row.unread = chat.is_some_and(|chat| self.unread_chats.contains(chat));
                    row.selected = chat.is_some() && chat.map(str::to_string) == selected;
                    if run.flow.is_some() {
                        row.trailing = Some(IconName::ArrowRight01);
                        row.on_click = Some(show_flow_run(run.id.clone()));
                    } else if let Some(chat) = chat {
                        row.trailing = Some(IconName::ArrowRight01);
                        row.on_click = Some(open_chat(chat));
                    }
                    let lines = attempts(run);
                    if lines.is_empty() { row.render(cx) } else { div().child(row.render(cx)).children(lines).into_any_element() }
                }
                RunEntry::Fold(fold) => self.fold_element(fold, &selected, &open_chat, &toggle, &attempts, cx),
            }
        };

        div()
            .id("routine-run-list")
            .debug_selector(|| "routine-run-list".into())
            .mx(px(-8.0))
            .flex()
            .flex_col()
            .children(days.iter().take(self.shown_days).map(|day| {
                let open = day.recent || self.expanded.contains(&format!("day:{}", day.key));
                let summary_key = format!("day:{}", day.key);
                div()
                    .debug_selector({
                        let label = format!("routine-run-day-{}", day.label);
                        move || label.clone()
                    })
                    .flex()
                    .flex_col()
                    .pt(px(12.0))
                    .child(div().px(px(8.0)).pb(px(4.0)).child(SectionLabel::new(day.label.clone())))
                    .when(!day.recent, |el| {
                        let mut row = Row::new(
                            format!("routine-run-day-summary-{}", day.label),
                            "All day",
                            IconName::Calendar03,
                            day_summary(&day.runs),
                        );
                        row.muted = true;
                        row.trailing = Some(if open { IconName::UnfoldLess } else { IconName::UnfoldMore });
                        row.on_click = Some(toggle(summary_key.clone()));
                        el.child(row.render(cx))
                    })
                    .when(open, |el| el.children(day.entries.iter().map(&entry)))
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .mt(px(16.0))
                    .px(px(8.0))
                    .when(count > self.shown_days, |el| {
                        el.child(
                            Button::new("routine-run-earlier", "Show earlier days")
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S28)
                                .on_click(act(&view, |this, _, cx| {
                                    this.shown_days += MORE_DAYS;
                                    cx.notify();
                                })),
                        )
                    })
                    .child(div().ml_auto().text_step(TEXT_12).text_color(theme.ink3).child("Keeps the newest 50 Runs that acted")),
            )
            .into_any_element()
    }

    fn fold_element(
        &self,
        fold: &Fold,
        selected: &Option<String>,
        open_chat: &dyn Fn(&str) -> Handler,
        toggle: &dyn Fn(String) -> Handler,
        attempts: &dyn Fn(&Run) -> Vec<AnyElement>,
        cx: &App,
    ) -> AnyElement {
        let oldest = fold.runs.last().map_or(String::new(), |run| run.id.clone());
        let key = format!("fold:{oldest}");
        let open = self.expanded.contains(&key);
        let icon = if fold.counts.quiet > 0 {
            IconName::Moon02
        } else if fold.counts.skipped > 0 {
            IconName::Next
        } else {
            IconName::Clock01
        };
        let mut head = Row::new(format!("routine-fold-{oldest}"), fold_times(fold, &words::ZONE), icon, fold_text(fold));
        head.muted = true;
        head.trailing = Some(if open { IconName::UnfoldLess } else { IconName::UnfoldMore });
        head.on_click = Some(toggle(key));
        let mut lines: Vec<AnyElement> = Vec::new();
        if open {
            for run in &fold.runs {
                let (icon, text) = folded_line(run);
                let chat = (run.status == RunStatus::Quiet && !run.rejected)
                    .then_some(run.chat_id.as_deref())
                    .flatten()
                    .filter(|chat| self.can_open(chat));
                let mut row = Row::new(format!("routine-run-{}", run.id), clock(run.started_at, &words::ZONE), icon, text);
                row.muted = true;
                row.unread = chat.is_some_and(|chat| self.unread_chats.contains(chat));
                row.selected = chat.is_some() && chat.map(str::to_string) == *selected;
                if let Some(chat) = chat {
                    row.trailing = Some(IconName::ArrowRight01);
                    row.on_click = Some(open_chat(chat));
                }
                lines.push(row.render(cx));
                lines.extend(attempts(run));
            }
        }
        div().flex().flex_col().child(head.render(cx)).children(lines).into_any_element()
    }
}

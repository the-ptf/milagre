//! The Clean up worktrees dialog (`settings/WorktreeCleanup.tsx`): the worktrees no Chat has used for 30, 60 or 90 days
//! in two groups (no unsaved work, unsaved work), those with nothing unsaved checked at first, removed one at a time
//! with progress and Stop. Its state is the global [`CleanupState`]; the dialog's body is rebuilt from it on every
//! `window.refresh()`. The fixture removes a worktree every 300 ms and takes it out of the store.

use std::collections::BTreeSet;
use std::time::Duration;

use gpui::{
    AnyElement, App, FontWeight, Global, InteractiveElement, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*, px,
};

use super::logic::{
    CLEANUP_INTRO, CLEANUP_TITLE, IDLE_DAYS, IdleWorktree, SAVED_GROUP, UNSAVED_GROUP, cleanup_groups, cleanup_toast, group_line, idle_for,
    progress_line, remove_label, row_date, row_detail, row_size, selection_line,
};
use super::model::{DevicesStore, now_ms};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonVariant, Checkbox, Dialog, Segmented, SegmentedOption};

/// What the open dialog remembers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CleanupState {
    /// The paired computer it cleans, named in the description; none for this Mac.
    pub computer: Option<String>,
    pub days: u32,
    pub selected: BTreeSet<String>,
    /// Worktrees removed so far while removing.
    pub progress: Option<usize>,
    pub total: usize,
    pub stopping: bool,
    /// The moment the dialog opened: the age of a worktree is measured from it.
    pub now: i64,
}

impl Global for CleanupState {}

fn visible(store: &DevicesStore, state: &CleanupState) -> Vec<IdleWorktree> {
    idle_for(&store.idle, state.days, state.now)
}

fn saved_paths(list: &[IdleWorktree]) -> BTreeSet<String> {
    cleanup_groups(list).0.into_iter().map(|item| item.path).collect()
}

fn change(cx: &mut App, f: impl FnOnce(&mut CleanupState)) {
    cx.update_global::<CleanupState, _>(|state, _| f(state));
}

/// Opens the dialog for this Mac (`None`) or a paired computer.
pub fn open(computer: Option<String>, window: &mut Window, cx: &mut App) {
    let now = now_ms();
    let selected = saved_paths(&idle_for(&cx.global::<DevicesStore>().idle, 30, now));
    cx.set_global(CleanupState { computer: computer.clone(), days: 30, selected, progress: None, total: 0, stopping: false, now });
    let description = match &computer {
        Some(name) => format!("{CLEANUP_INTRO} On {name}."),
        None => CLEANUP_INTRO.to_string(),
    };
    Dialog::new(CLEANUP_TITLE)
        .description(description)
        .width(600.0)
        .body(|_, cx| body(cx))
        .on_close(|_, cx| change(cx, |state| state.stopping = state.progress.is_some()))
        .open(window, cx);
}

fn group_card(id: &'static str, title: &'static str, list: &[IdleWorktree], state: &CleanupState, unsaved: bool, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    let picked = list.iter().filter(|item| state.selected.contains(&item.path)).count();
    let all = !list.is_empty() && picked == list.len();
    let busy = state.progress.is_some();
    let paths: Vec<String> = list.iter().map(|item| item.path.clone()).collect();
    let toggle_paths = paths.clone();
    div()
        .id(id)
        .debug_selector(move || id.to_string())
        .min_w_0()
        .flex_1()
        .flex()
        .items_center()
        .gap(px(12.0))
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(if picked > 0 { theme.line_strong } else { theme.line })
        .when(picked > 0, |d| d.bg(crate::settings::devices::widgets::hover_half(cx)))
        .px(px(12.0))
        .py(px(10.0))
        .when(list.is_empty(), |d| d.opacity(0.6))
        .child(Checkbox::new(SharedString::from(format!("{id}-check")), all).disabled(busy || list.is_empty()).on_toggle(
            move |on, window, cx| {
                change(cx, |state| {
                    for path in &toggle_paths {
                        if on {
                            state.selected.insert(path.clone());
                        } else {
                            state.selected.remove(path);
                        }
                    }
                });
                window.refresh();
            },
        ))
        .child(
            div()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink)
                        .child(title)
                        .when(unsaved, |d| d.child(div().size(px(6.0)).flex_none().rounded_full().bg(theme.orange))),
                )
                .child(div().truncate().text_step(TEXT_12).text_color(theme.ink3).child(group_line(list))),
        )
        .into_any_element()
}

fn item_row(item: &IdleWorktree, state: &CleanupState, now: i64, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    let busy = state.progress.is_some();
    let path = item.path.clone();
    let checked = state.selected.contains(&item.path);
    let title = item.title.clone();
    div()
        .id(SharedString::from(format!("cleanup-row-{}", item.title)))
        .debug_selector(move || format!("cleanup-row-{title}"))
        .flex()
        .items_center()
        .gap(px(12.0))
        .px(px(12.0))
        .py(px(8.0))
        .cursor_pointer()
        .hover(move |s| s.bg(crate::settings::devices::widgets::hover_half_color(&theme)))
        .on_click({
            let path = path.clone();
            move |_, window, cx| {
                if busy {
                    return;
                }
                change(cx, |state| {
                    if !state.selected.remove(&path) {
                        state.selected.insert(path.clone());
                    }
                });
                window.refresh();
            }
        })
        .child(Checkbox::new(SharedString::from(format!("cleanup-check-{}", item.title)), checked).disabled(busy))
        .child(
            div()
                .min_w_0()
                .flex_1()
                .flex()
                .flex_col()
                .child(div().truncate().text_step(TEXT_13).text_color(theme.ink).child(item.title.clone()))
                .child(
                    div()
                        .truncate()
                        .text_step(TEXT_12)
                        .text_color(if item.status.removable { theme.ink3 } else { theme.orange_ink })
                        .child(row_detail(item)),
                ),
        )
        .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(row_date(item.last_at, now)))
        .child(
            div().w(px(64.0)).flex_none().text_step(TEXT_12).text_color(theme.ink2).child(div().flex().justify_end().child(row_size(item))),
        )
        .into_any_element()
}

fn body(cx: &mut App) -> AnyElement {
    let theme = *cx.theme();
    let store = cx.global::<DevicesStore>().clone();
    let state = cx.global::<CleanupState>().clone();
    let list = visible(&store, &state);
    let (saved, unsaved) = cleanup_groups(&list);
    let chosen: Vec<IdleWorktree> =
        saved.iter().chain(unsaved.iter()).filter(|item| state.selected.contains(&item.path)).cloned().collect();
    let busy = state.progress.is_some();

    let days = Segmented::new(
        "cleanup-days",
        Some(&state.days.to_string()),
        IDLE_DAYS.iter().map(|d| SegmentedOption::new(d.to_string(), format!("{d} days")).disabled(busy)),
    )
    .large()
    .on_change(|value, window, cx| {
        let days: u32 = value.parse().unwrap_or(30);
        let store_idle = cx.global::<DevicesStore>().idle.clone();
        change(cx, |state| {
            state.days = days;
            // A new span starts from what it would remove safely.
            state.selected = saved_paths(&idle_for(&store_idle, days, state.now));
        });
        window.refresh();
    });

    let content: AnyElement = if list.is_empty() {
        div()
            .debug_selector(|| "cleanup-empty".into())
            .py(px(24.0))
            .flex()
            .justify_center()
            .text_step(TEXT_13)
            .text_color(theme.ink3)
            .child(format!("No worktree has gone unused for {} days.", state.days))
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(
                div()
                    .flex()
                    .gap(px(12.0))
                    .child(group_card("cleanup-group-saved", SAVED_GROUP, &saved, &state, false, cx))
                    .child(group_card("cleanup-group-unsaved", UNSAVED_GROUP, &unsaved, &state, true, cx)),
            )
            .child(
                div()
                    .id("cleanup-list")
                    .max_h(px(300.0))
                    .overflow_y_scroll()
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line)
                    .flex()
                    .flex_col()
                    .children(saved.iter().chain(unsaved.iter()).map(|item| item_row(item, &state, state.now, cx))),
            )
            .child(
                div()
                    .debug_selector(|| "cleanup-selection".into())
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(selection_line(&chosen)),
            )
            .into_any_element()
    };

    let status = busy.then(|| progress_line(state.progress.unwrap_or(0), state.total));
    let actions: AnyElement = if busy {
        div()
            .flex()
            .gap(px(8.0))
            .child(
                Button::new("cleanup-stop", if state.stopping { "Stopping\u{2026}" } else { "Stop" })
                    .variant(ButtonVariant::Ghost)
                    .disabled(state.stopping)
                    .on_click(|_, window, cx| {
                        change(cx, |state| state.stopping = true);
                        window.refresh();
                    }),
            )
            .child(Button::new("cleanup-removing", "Removing\u{2026}").variant(ButtonVariant::Danger).disabled(true))
            .into_any_element()
    } else {
        let count = chosen.len();
        div()
            .flex()
            .gap(px(8.0))
            .child(
                Button::new("cleanup-cancel", "Cancel").variant(ButtonVariant::Ghost).on_click(|_, window, cx| Dialog::close(window, cx)),
            )
            .child(
                Button::new("cleanup-remove", remove_label(count))
                    .variant(ButtonVariant::Danger)
                    .disabled(count == 0)
                    .on_click(move |_, window, cx| remove(chosen.clone(), window, cx)),
            )
            .into_any_element()
    };

    div()
        .debug_selector(|| "worktree-cleanup".into())
        .mt(px(4.0))
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(div().flex().child(days))
        .child(content)
        .child(
            div()
                .mt(px(4.0))
                .flex()
                .items_center()
                .justify_between()
                .child(div().debug_selector(|| "cleanup-status".into()).text_step(TEXT_12).text_color(theme.ink3).children(status))
                .child(actions),
        )
        .into_any_element()
}

/// Removes the chosen worktrees one at a time, so the dialog shows progress and Stop takes effect before the next one.
fn remove(chosen: Vec<IdleWorktree>, window: &mut Window, cx: &mut App) {
    if chosen.is_empty() || cx.global::<CleanupState>().progress.is_some() {
        return;
    }
    change(cx, |state| {
        state.progress = Some(0);
        state.total = chosen.len();
        state.stopping = false;
    });
    window.refresh();
    window
        .spawn(cx, async move |cx| {
            let mut removed = 0;
            let mut stopped = false;
            for item in chosen {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                if cx.update(|_, cx| cx.global::<CleanupState>().stopping).unwrap_or(true) {
                    stopped = true;
                    break;
                }
                removed += 1;
                let path = item.path.clone();
                cx.update(|window, cx| {
                    cx.update_global::<DevicesStore, _>(|store, _| store.remove_idle(&path));
                    change(cx, |state| state.progress = Some(removed));
                    window.refresh();
                })
                .ok();
            }
            cx.update(|window, cx| {
                let toast = cleanup_toast(removed, &[], stopped);
                cx.update_global::<DevicesStore, _>(|store, _| store.last_toast = Some(toast));
                change(cx, |state| state.progress = None);
                Dialog::close(window, cx);
            })
            .ok();
        })
        .detach();
}

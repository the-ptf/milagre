//! Undo, in the composer's place (`UndoPanel.tsx`, `use-checkpoints.ts`, `checkpoints.ts`): the Chat's tasks that
//! changed files (list, Enter to preview), then one task's files with what undoing does to each. Only a file edited
//! after the task asks Keep current or Undo, and the button stays off until every such file has an answer.
//!
//! The tasks and previews are fixtures (`checkpoint:list`, `checkpoint:preview` and `checkpoint:restore` are the
//! DataSource calls that replace them). The text helpers are ports of `checkpoints.ts`.
//!
//! Not built: the panel's `fade-up` entrance, Esc Esc as the shortcut that opens it (`/undo` in the composer opens
//! it), the outline on the task's message in the transcript (the panel emits `Highlight`, nothing draws it yet), the
//! Changes panel opening on a file (`OpenFile`), a pending state (the fixture answers at once).

use std::collections::HashMap;

use gpui::{
    AnyElement, ClickEvent, Context, ElementId, EventEmitter, FocusHandle, Focusable, FontWeight, IntoElement, KeyDownEvent, ParentElement,
    Render, ScrollHandle, SharedString, Styled, Window, div, prelude::*, px,
};

use crate::theme::{ActiveTheme, RADIUS_CHIP, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, EmptySize, EmptyState, Icon, IconButton, IconButtonSize, IconName, IconSize, ScrollArea, Segmented,
    SegmentedOption, ShortcutKeys,
};

const DAY: i64 = 86_400_000;
/// The panel is never taller than this (`max-h-[min(420px,55vh)]`).
pub const MAX_HEIGHT: f32 = 420.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Undo,
    Redo,
}

impl Intent {
    pub fn word(self) -> &'static str {
        match self {
            Intent::Undo => "Undo",
            Intent::Redo => "Redo",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Create,
    Replace,
    Delete,
}

/// `CheckpointFile`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointFile {
    pub key: String,
    pub path: String,
    pub action: Action,
    pub conflict: bool,
}

/// `Checkpoint`, with its preview's files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub id: String,
    pub created_at: i64,
    pub message_id: Option<u64>,
    pub prompt: Option<String>,
    /// How many files the task changed; `None` for one that ended without a final capture.
    pub changed: Option<usize>,
    pub files: Vec<CheckpointFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Keep,
    Restore,
}

/// What the panel tells the Chat column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UndoEvent {
    /// The user message of the task in view, or none.
    Highlight(Option<u64>),
    /// The panel closed: the prompt takes the focus back.
    Closed,
    Restored {
        files: usize,
    },
    OpenFile(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    List,
    Preview,
}

// ---- checkpoints.ts ----

/// `"8:00 AM"` today, `"Yesterday"`, else the date (UTC, the fixture's clock).
pub fn checkpoint_time(at: i64, now: i64) -> String {
    let (day, today) = (at.div_euclid(DAY), now.div_euclid(DAY));
    if day == today {
        let minutes = at.rem_euclid(DAY) / 60_000;
        let (hour, minute) = (minutes / 60, minutes % 60);
        return format!("{}:{minute:02} {}", if hour % 12 == 0 { 12 } else { hour % 12 }, if hour < 12 { "AM" } else { "PM" });
    }
    if today - day == 1 {
        return "Yesterday".into();
    }
    // civil_from_days (Howard Hinnant).
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let _ = era;
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {d}", MONTHS[(m - 1) as usize])
}

/// The task as one line: the first line of what the user wrote.
pub fn checkpoint_task(item: &Checkpoint) -> String {
    item.prompt.as_deref().and_then(|prompt| prompt.lines().map(str::trim).find(|line| !line.is_empty())).unwrap_or("Task").to_string()
}

/// `"3 files · 8:00 AM"`; a task that never got its final capture says so.
pub fn checkpoint_meta(item: &Checkpoint, now: i64) -> String {
    let files = match item.changed {
        None => "Interrupted".to_string(),
        Some(1) => "1 file".to_string(),
        Some(n) => format!("{n} files"),
    };
    format!("{files} \u{b7} {}", checkpoint_time(item.created_at, now))
}

/// What undoing does to a file.
pub fn checkpoint_effect(file: &CheckpointFile) -> &'static str {
    match file.action {
        Action::Replace => "Revert",
        Action::Delete => "Delete",
        Action::Create => "Restore",
    }
}

/// `"login.ts"` and `"src/auth"`.
pub fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(at) => (&path[at + 1..], &path[..at]),
        None => (path, ""),
    }
}

/// `undoableTasks`: the tasks Undo offers, newest first: ones that changed files, or that ended without a final capture.
pub fn undoable(items: &[Checkpoint]) -> Vec<Checkpoint> {
    items.iter().filter(|item| item.changed != Some(0)).cloned().collect()
}

// ---- use-checkpoints.ts derived state ----

/// Conflicts still waiting for Keep current or Undo.
pub fn conflicts(preview: &Checkpoint, decisions: &HashMap<String, Decision>) -> usize {
    preview.files.iter().filter(|file| file.conflict && !decisions.contains_key(&file.key)).count()
}

/// Files the restore will write.
pub fn restore_count(preview: &Checkpoint, decisions: &HashMap<String, Decision>) -> usize {
    preview.files.iter().filter(|file| decisions.get(&file.key) == Some(&Decision::Restore)).count()
}

/// The decisions a fresh preview starts with: every file that is not in conflict is restored.
pub fn initial_decisions(preview: &Checkpoint) -> HashMap<String, Decision> {
    preview.files.iter().filter(|file| !file.conflict).map(|file| (file.key.clone(), Decision::Restore)).collect()
}

/// `"Undo 3 files"`: every file until the conflicts are answered, then the ones that will change.
pub fn restore_label(intent: Intent, preview: Option<&Checkpoint>, decisions: &HashMap<String, Decision>) -> String {
    let resolved = preview.is_some_and(|p| conflicts(p, decisions) == 0);
    let count = match preview {
        Some(p) if resolved => restore_count(p, decisions),
        Some(p) => p.files.len(),
        None => 0,
    };
    if resolved && count == 0 {
        return format!("Nothing to {}", intent.word().to_lowercase());
    }
    format!("{} {count} {}", intent.word(), if count == 1 { "file" } else { "files" })
}

// ---- fixture ----

pub const NOW: i64 = super::pills::data::NOW;

fn file(key: &str, path: &str, action: Action, conflict: bool) -> CheckpointFile {
    CheckpointFile { key: key.into(), path: path.into(), action, conflict }
}

/// The Chat's undoable tasks, newest first.
pub fn fixture() -> Vec<Checkpoint> {
    let at = |ago: i64| NOW - ago;
    vec![
        Checkpoint {
            id: "c4".into(),
            created_at: at(25 * 60_000),
            message_id: Some(41),
            prompt: Some("Add a timer fallback to the star layer\nand cover it with a check".into()),
            changed: Some(3),
            files: vec![
                file("f1", "apps/desktop/app/src/intro/Dawn.tsx", Action::Replace, false),
                file("f2", "scripts/test-onboarding.cjs", Action::Replace, true),
                file("f3", "apps/desktop/app/src/intro/timer.ts", Action::Create, false),
            ],
        },
        Checkpoint {
            id: "c3".into(),
            created_at: at(2 * 3_600_000),
            message_id: Some(33),
            prompt: Some("Find why the intro hangs on Linux".into()),
            changed: Some(1),
            files: vec![file("g1", "docs/notes/intro-hang.md", Action::Delete, false)],
        },
        Checkpoint {
            id: "c2".into(),
            created_at: at(DAY + 3_600_000),
            message_id: Some(20),
            prompt: Some("Tidy the onboarding copy".into()),
            changed: None,
            files: vec![],
        },
        Checkpoint {
            id: "c1".into(),
            created_at: at(4 * DAY),
            message_id: Some(7),
            prompt: Some("Rename the intro layers".into()),
            changed: Some(2),
            files: vec![
                file("h1", "apps/desktop/app/src/intro/Layers.tsx", Action::Replace, false),
                file("h2", "apps/desktop/app/src/intro/Stars.tsx", Action::Replace, false),
            ],
        },
    ]
}

pub struct UndoPanel {
    intent: Intent,
    tasks: Vec<Checkpoint>,
    view: View,
    active: usize,
    preview: Option<Checkpoint>,
    decisions: HashMap<String, Decision>,
    notice: Option<SharedString>,
    now: i64,
    focus: FocusHandle,
    scroll: ScrollHandle,
}

impl EventEmitter<UndoEvent> for UndoPanel {}

impl Focusable for UndoPanel {
    fn focus_handle(&self, _cx: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl UndoPanel {
    /// `Undo`: the task list. `Redo`: the recovery checkpoint an undo saved, previewed at once.
    pub fn new(intent: Intent, items: Vec<Checkpoint>, cx: &mut Context<Self>) -> Self {
        let tasks = undoable(&items);
        let mut this = Self {
            intent,
            tasks,
            view: View::List,
            active: 0,
            preview: None,
            decisions: HashMap::new(),
            notice: None,
            now: NOW,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
        };
        if intent == Intent::Redo
            && let Some(first) = items.first().cloned()
        {
            this.show(first, cx);
        }
        this.emit_highlight(cx);
        this
    }

    pub fn view(&self) -> View {
        self.view
    }

    pub fn intent(&self) -> Intent {
        self.intent
    }

    pub fn tasks(&self) -> &[Checkpoint] {
        &self.tasks
    }

    pub fn active(&self) -> usize {
        self.active.min(self.tasks.len().saturating_sub(1))
    }

    pub fn preview(&self) -> Option<&Checkpoint> {
        self.preview.as_ref()
    }

    pub fn decisions(&self) -> &HashMap<String, Decision> {
        &self.decisions
    }

    pub fn can_restore(&self) -> bool {
        self.preview.as_ref().is_some_and(|p| conflicts(p, &self.decisions) == 0 && restore_count(p, &self.decisions) > 0)
    }

    /// The user message of the task in view.
    fn highlighted(&self) -> Option<u64> {
        match self.view {
            View::List => self.tasks.get(self.active()).and_then(|task| task.message_id),
            View::Preview => self.preview.as_ref().and_then(|p| p.message_id),
        }
    }

    fn emit_highlight(&self, cx: &mut Context<Self>) {
        cx.emit(UndoEvent::Highlight(self.highlighted()));
    }

    pub fn set_active(&mut self, ix: usize, cx: &mut Context<Self>) {
        if self.view == View::List && !self.tasks.is_empty() {
            self.active = ix.min(self.tasks.len() - 1);
            self.emit_highlight(cx);
            cx.notify();
        }
    }

    fn show(&mut self, preview: Checkpoint, cx: &mut Context<Self>) {
        self.decisions = initial_decisions(&preview);
        self.preview = Some(preview);
        self.view = View::Preview;
        self.notice = None;
        self.emit_highlight(cx);
        cx.notify();
    }

    /// `inspect`: previews a task's files.
    pub fn inspect(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(task) = self.tasks.iter().find(|task| task.id == id).cloned() {
            self.show(task, cx);
        }
    }

    /// `back`: to the list.
    pub fn back(&mut self, cx: &mut Context<Self>) {
        self.preview = None;
        self.view = View::List;
        self.notice = None;
        self.emit_highlight(cx);
        cx.notify();
    }

    pub fn choose(&mut self, key: &str, decision: Decision, cx: &mut Context<Self>) {
        self.decisions.insert(key.to_string(), decision);
        cx.notify();
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(UndoEvent::Highlight(None));
        cx.emit(UndoEvent::Closed);
    }

    /// `restore`: writes the files (the fixture only counts them), drops the task from the list and closes.
    pub fn restore(&mut self, cx: &mut Context<Self>) {
        let Some(preview) = self.preview.take() else { return };
        if !self.can_restore_for(&preview) {
            self.preview = Some(preview);
            return;
        }
        let files = restore_count(&preview, &self.decisions);
        self.tasks.retain(|task| task.id != preview.id);
        cx.emit(UndoEvent::Restored { files });
        self.close(cx);
    }

    fn can_restore_for(&self, preview: &Checkpoint) -> bool {
        conflicts(preview, &self.decisions) == 0 && restore_count(preview, &self.decisions) > 0
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "escape" => {
                cx.stop_propagation();
                if self.view == View::Preview && !self.tasks.is_empty() && self.intent == Intent::Undo {
                    self.back(cx);
                } else {
                    self.close(cx);
                }
            }
            "down" | "up" if self.view == View::List && !self.tasks.is_empty() => {
                let n = self.tasks.len();
                let next = (self.active() + if event.keystroke.key == "down" { 1 } else { n - 1 }) % n;
                self.set_active(next, cx);
            }
            "enter" if self.view == View::List => {
                if let Some(task) = self.tasks.get(self.active()) {
                    let id = task.id.clone();
                    self.inspect(&id, cx);
                }
            }
            _ => {}
        }
    }
}

fn file_icon(action: Action) -> IconName {
    match action {
        Action::Replace => IconName::FileEdit,
        Action::Delete => IconName::FileAdd,
        Action::Create => IconName::FileRemove,
    }
}

impl Render for UndoPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let body = match self.view {
            View::List => self.render_list(&theme, cx),
            View::Preview => self.render_preview(&theme, cx),
        };
        div()
            .id("undo-panel")
            .debug_selector(|| "undo-panel".into())
            .key_context("UndoPanel")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.on_key_down(event, cx)))
            .w_full()
            .max_h(px(MAX_HEIGHT))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(RADIUS_WINDOW)
            .border_1()
            .border_color(theme.line_strong)
            .bg(theme.surface)
            .text_step(TEXT_13)
            .text_color(theme.ink)
            .child(body)
    }
}

impl UndoPanel {
    fn render_list(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let active = self.active();
        let now = self.now;
        let rows: Vec<AnyElement> = self
            .tasks
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let id = item.id.clone();
                div()
                    .id(ElementId::from(SharedString::from(format!("checkpoint-{}", item.id))))
                    .debug_selector({
                        let id = item.id.clone();
                        move || format!("checkpoint-{id}")
                    })
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_4()
                    .h(px(32.0))
                    .w_full()
                    .px(px(10.0))
                    .rounded(RADIUS_CONTROL)
                    .cursor_pointer()
                    .when(index == active, |el| el.bg(theme.hover2))
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered {
                            this.set_active(index, cx);
                        }
                    }))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.inspect(&id, cx)))
                    .child(div().flex_1().min_w_0().truncate().child(checkpoint_task(item)))
                    .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(checkpoint_meta(item, now)))
                    .into_any_element()
            })
            .collect();
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .pt_2()
                    .pb_1p5()
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(Icon::new(IconName::Undo02).size(IconSize::S14).color(theme.ink2))
                    .child(div().flex_1().font_weight(FontWeight::MEDIUM).child("Undo a task's changes"))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .text_step(TEXT_11)
                            .text_color(theme.ink3)
                            .child(ShortcutKeys::new("Enter").compact())
                            .child("preview")
                            .child(div().ml_1p5().child(ShortcutKeys::new("Esc").compact()))
                            .child("close"),
                    ),
            )
            .child(div().min_h_0().flex_1().px(px(6.0)).pb(px(6.0)).child(if rows.is_empty() {
                div().child(EmptyState::new().size(EmptySize::Compact).title("No task has changed files yet")).into_any_element()
            } else {
                div()
                    .h(px((rows.len() as f32 * 32.0).min(MAX_HEIGHT - 40.0)))
                    .child(ScrollArea::new("undo-tasks", &self.scroll).children(rows))
                    .into_any_element()
            }))
            .into_any_element()
    }

    fn render_preview(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let intent = self.intent;
        let now = self.now;
        let preview = self.preview.clone();
        let header = div()
            .flex_none()
            .flex()
            .items_center()
            .gap_2()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(theme.line)
            .child(
                Icon::new(if intent == Intent::Redo { IconName::Redo02 } else { IconName::Undo02 }).size(IconSize::S16).color(theme.ink2),
            )
            .child(
                div().flex_none().font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(format!("{} changes from", intent.word())),
            )
            .children(preview.as_ref().map(|p| {
                let title = checkpoint_task(p);
                let chooser = !self.tasks.is_empty() && intent == Intent::Undo;
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .min_w_0()
                    .child(if chooser {
                        div()
                            .id("undo-choose-task")
                            .debug_selector(|| "undo-choose-task".into())
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .h(px(24.0))
                            .min_w_0()
                            .px_2()
                            .rounded(RADIUS_CHIP)
                            .bg(theme.field)
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(move |style| style.bg(theme.hover2))
                            .child(div().truncate().child(title))
                            .child(Icon::new(IconName::UnfoldMore).size(IconSize::S12).color(theme.ink3))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.back(cx)))
                            .into_any_element()
                    } else {
                        div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(title).into_any_element()
                    })
                    .child(div().flex_none().text_color(theme.ink3).child(checkpoint_time(p.created_at, now)))
            }))
            .child(
                div().ml_auto().child(
                    IconButton::new("undo-close", IconName::Cancel01)
                        .size(IconButtonSize::S24)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close(cx))),
                ),
            );
        let files: AnyElement = match &preview {
            None => div().px_3().py_3().text_color(theme.ink3).child("Checking files\u{2026}").into_any_element(),
            Some(p) if p.files.is_empty() => {
                div().px_3().py_3().text_color(theme.ink3).child("These files are already as they were before the task.").into_any_element()
            }
            Some(p) => {
                let rows: Vec<AnyElement> = p.files.iter().map(|file| self.file_row(file, &theme, cx)).collect();
                div()
                    .min_h_0()
                    .flex_1()
                    .py_1()
                    .h(px((rows.len() as f32 * 40.0 + 8.0).min(MAX_HEIGHT - 110.0)))
                    .child(ScrollArea::new("undo-files", &self.scroll).children(rows))
                    .into_any_element()
            }
        };
        let pending_conflicts = preview.as_ref().map_or(0, |p| conflicts(p, &self.decisions));
        let footer_text: AnyElement = if pending_conflicts > 0 {
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap_1p5()
                .text_step(TEXT_12)
                .text_color(theme.orange_ink)
                .child(Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.orange_ink))
                .child(if pending_conflicts == 1 {
                    "1 file needs a choice".to_string()
                } else {
                    format!("{pending_conflicts} files need a choice")
                })
                .into_any_element()
        } else {
            let hint = preview
                .as_ref()
                .filter(|p| !p.files.is_empty())
                .map(|_| format!("You can {} this.", if intent == Intent::Undo { "redo" } else { "undo" }));
            div().flex_1().min_w_0().text_step(TEXT_12).text_color(theme.ink3).child(hint.unwrap_or_default()).into_any_element()
        };
        let label = restore_label(intent, preview.as_ref(), &self.decisions);
        let enabled = self.can_restore();
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .child(header)
            .children(self.notice.clone().map(|notice| {
                div().px_3().py_2().border_b_1().border_color(theme.line).text_step(TEXT_12).text_color(theme.orange_ink).child(notice)
            }))
            .child(files)
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_2()
                    .border_t_1()
                    .border_color(theme.line)
                    .child(footer_text)
                    .child(
                        Button::new("undo-cancel", "Cancel")
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::S28)
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.close(cx))),
                    )
                    .child(
                        Button::new("checkpoint-restore", label)
                            .size(ButtonSize::S28)
                            .disabled(!enabled)
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.restore(cx))),
                    ),
            )
            .into_any_element()
    }

    fn file_row(&self, file: &CheckpointFile, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let theme = *theme;
        let (name, dir) = split_path(&file.path);
        let (name, dir) = (name.to_string(), dir.to_string());
        let intent = self.intent;
        let effect = if intent == Intent::Redo && file.action == Action::Replace { "Reapply" } else { checkpoint_effect(file) };
        let decision = self.decisions.get(&file.key).copied();
        let (key, path) = (file.key.clone(), file.path.clone());
        let open_path = path.clone();
        div()
            .debug_selector({
                let key = file.key.clone();
                move || format!("checkpoint-file-{key}")
            })
            .flex_none()
            .flex()
            .items_center()
            .gap_2()
            .min_h(px(40.0))
            .px_3()
            .py_1()
            .when(file.conflict, |el| el.bg(theme.orange_tint))
            .child(div().flex_none().child(Icon::new(file_icon(file.action)).size(IconSize::S16).color(theme.ink3)))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap_2()
                    .min_w_0()
                    .child(div().truncate().font_weight(FontWeight::MEDIUM).child(name))
                    .when(!dir.is_empty(), |el| el.child(div().truncate().text_color(theme.ink3).child(dir))),
            )
            .when(file.conflict, |el| {
                el.child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap_1p5()
                        .text_step(TEXT_12)
                        .text_color(theme.orange_ink)
                        .child(div().size(px(6.0)).rounded_full().bg(theme.orange))
                        .child("Edited after this task"),
                )
            })
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap_1p5()
                    .child(if file.conflict {
                        let this = cx.entity();
                        let key = key.clone();
                        Segmented::new(
                            ElementId::from(SharedString::from(format!("checkpoint-choice-{}", file.key))),
                            decision.map(|d| if d == Decision::Keep { "keep" } else { "restore" }),
                            [SegmentedOption::new("keep", "Keep current"), SegmentedOption::new("restore", intent.word())],
                        )
                        .on_change(move |value, _, cx| {
                            let decision = if value.as_ref() == "keep" { Decision::Keep } else { Decision::Restore };
                            this.update(cx, |this, cx| this.choose(&key, decision, cx));
                        })
                        .into_any_element()
                    } else {
                        div().text_step(TEXT_12).text_color(theme.ink2).child(effect).into_any_element()
                    })
                    .child(
                        IconButton::new(
                            ElementId::from(SharedString::from(format!("checkpoint-open-{}", file.key))),
                            IconName::ArrowRight01,
                        )
                        .size(IconButtonSize::S24)
                        .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(UndoEvent::OpenFile(open_path.clone())))),
                    ),
            )
            .into_any_element()
    }
}

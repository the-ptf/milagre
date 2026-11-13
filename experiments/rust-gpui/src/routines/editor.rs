//! New Routine, or Edit (R-04: `RoutineEditor.tsx`, `use-routine-form.tsx`), in place of the Routine's page: the name as a
//! field with Cancel and Save, a single prompt or a flow and how it starts (new only), the settings as chips that open
//! their pickers (Schedule and Where in popovers), Prompt (`placeholders.rs`), Stop after, and Delete Routine (edit only).
//!
//! The form's state, validation and what it saves are `form.rs` (`routine-form.mjs`); this view is the fields. Text
//! fields keep their text in `InputState`s and are read into the form on every change, so `form` is always what Save
//! would validate. Cancel with changes asks to discard them first. Not built: native time and date pickers (the time
//! and the stop date are text fields that check their shape), the 22px name field (a 36px field).

use std::collections::HashMap;

use gpui::{
    AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, EventEmitter, FontWeight, IntoElement, ParentElement, Render,
    ScrollHandle, SharedString, Styled, Subscription, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::fixture;
use super::form::{
    self, EveryUnit, Field, PROMPT_PLACEHOLDER, RoutineForm, RoutineInput, RoutinePatch, RunIn, ScheduleMode, StopKind, TriggerKind,
    empty_form, fallback_applies, first_run_at, form_from_routine, form_to_input, form_to_update, is_comment, prompt_hint, with_run_in,
};
use super::model::{self, DAY_MS, LinearEvent, Routine, Trigger, linear_options, model_choices, targets};
use super::placeholders::{PromptEvent, PromptField};
use super::prompt::placeholders_for;
use super::words::{self, clock, delete_warning, trigger_chip_text};
use super::{page::hook_url, routine_icon};
use crate::data::{Millis, Provider};
use crate::logic::copy::model_copy::PermissionMode;
use crate::logic::usage::time::{epoch_ms, local_time};
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Checkbox, Chip, ChipVariant, FieldSize, Icon, IconName, IconSize, InlineError, Input, Popover,
    ScrollArea, SectionLabel, Segmented, SegmentedOption, Select, SelectOption, SelectVariant,
};
use crate::workspace::chrome;

type Pick = Box<dyn Fn(&SharedString, &mut Window, &mut App)>;
const FORM_WIDTH: f32 = 680.0;
const TIMEZONES: [&str; 8] = [
    "UTC",
    "America/Sao_Paulo",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/Lisbon",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Tokyo",
];
const DEFAULT_SIGNATURE_HEADER: &str = "sentry-hook-signature";
const DAYS: [&str; 7] = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

pub enum EditorEvent {
    Cancel,
    Saved { id: String, patch: RoutinePatch },
    Created { input: RoutineInput, flow: bool },
    Deleted { id: String },
}

impl EventEmitter<EditorEvent> for RoutineEditor {}

pub struct RoutineEditor {
    pub(crate) initial: Option<Routine>,
    now: Millis,
    baseline: RoutineForm,
    pub(crate) form: RoutineForm,
    /// A new Routine as a flow: its steps carry the prompts.
    pub(crate) flow: bool,
    /// The form as the Flow page's Settings tab shows it: no window header, no scroll of its own, the page's width.
    pub(crate) embedded: bool,
    pub(crate) errors: HashMap<Field, String>,
    top_error: String,
    name: Entity<InputState>,
    cron: Entity<InputState>,
    time: Entity<InputState>,
    header: Entity<InputState>,
    secret: Entity<InputState>,
    runs: Entity<InputState>,
    date: Entity<InputState>,
    prompt: Entity<PromptField>,
    /// Cancel with changes asks to discard them.
    pub(crate) asking: bool,
    pub(crate) confirming: bool,
    created: bool,
    scroll: ScrollHandle,
    _subscriptions: Vec<Subscription>,
}

fn date_value(at: Millis) -> String {
    let local = local_time(at, &words::ZONE);
    format!("{:04}-{:02}-{:02}", local.year, local.month, local.day)
}

/// The end of the picked day on the zone's clock.
fn date_at(text: &str) -> Option<Millis> {
    let mut parts = text.trim().split('-');
    let (y, m, d): (i64, i64, i64) = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    ((1..=12).contains(&m) && (1..=31).contains(&d) && parts.next().is_none()).then(|| epoch_ms(y, m, d, 23, 59, 0))
}

impl RoutineEditor {
    pub fn new(initial: Option<Routine>, now: Millis, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let zone = "UTC";
        let mut form = match &initial {
            None => empty_form(zone, now),
            Some(routine) => {
                let mut form = form_from_routine(routine, zone, now);
                if form.run_in == RunIn::Chat {
                    form.project_path = chat_project(&form.chat_id);
                }
                form
            }
        };
        if initial.is_none() {
            form.project_path = targets().first().map(|project| project.path.clone()).unwrap_or_default();
        }
        let flow = initial.as_ref().is_some_and(|routine| routine.flow.is_some());
        let field = |placeholder: &str, text: &str, window: &mut Window, cx: &mut Context<Self>| {
            let state = Input::state(placeholder.to_string(), window, cx);
            state.update(cx, |state, cx| state.set_value(text.to_string(), window, cx));
            state
        };
        let name = field("Name this Routine", &form.name, window, cx);
        let cron = field("30 8 * * 1-5", &form.schedule.cron, window, cx);
        let time = field("09:00", &form.schedule.time, window, cx);
        let header = field(DEFAULT_SIGNATURE_HEADER, &form.webhook.signing_header, window, cx);
        let secret = Input::password_state("HMAC SHA-256 secret", window, cx);
        let runs = field("10", &form.stop.runs.to_string(), window, cx);
        let date = field("YYYY-MM-DD", &date_value(form.stop.at), window, cx);
        let placeholders = placeholders_for(form.trigger, form.linear.event);
        let prompt = cx.new(|cx| PromptField::new(PROMPT_PLACEHOLDER, placeholders, window, cx));
        prompt.update(cx, |prompt, cx| prompt.set_value(&form.prompt, window, cx));
        let mut subscriptions = Vec::new();
        for state in [&name, &cron, &time, &header, &secret, &runs, &date] {
            subscriptions.push(cx.subscribe(state, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    this.pull(cx);
                }
            }));
        }
        subscriptions.push(cx.subscribe(&prompt, |this, _, _: &PromptEvent, cx| this.pull(cx)));
        let baseline = form.clone();
        let editor = Self {
            initial,
            now,
            baseline,
            form,
            flow,
            embedded: false,
            errors: HashMap::new(),
            top_error: String::new(),
            name,
            cron,
            time,
            header,
            secret,
            runs,
            date,
            prompt,
            asking: false,
            confirming: false,
            created: false,
            scroll: ScrollHandle::new(),
            _subscriptions: subscriptions,
        };
        editor.name.update(cx, |state, cx| state.focus(window, cx));
        editor
    }

    /// Fills the name and the prompt, as typing would (tests).
    #[cfg(test)]
    pub(crate) fn type_into(&mut self, name: &str, prompt: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.name.update(cx, |state, cx| state.set_value(name.to_string(), window, cx));
        self.prompt.update(cx, |field, cx| field.set_value(prompt, window, cx));
        self.pull(cx);
    }

    #[cfg(test)]
    pub(crate) fn prompt_field(&self) -> Entity<PromptField> {
        self.prompt.clone()
    }

    pub fn editing(&self) -> bool {
        self.initial.is_some()
    }

    /// Reads the text fields into the form.
    fn pull(&mut self, cx: &mut Context<Self>) {
        let text = |state: &Entity<InputState>, cx: &App| state.read(cx).value().to_string();
        self.form.name = text(&self.name, cx);
        self.form.schedule.cron = text(&self.cron, cx);
        self.form.schedule.time = text(&self.time, cx);
        self.form.webhook.signing_header = text(&self.header, cx);
        self.form.webhook.signing_secret = text(&self.secret, cx);
        self.form.stop.runs = text(&self.runs, cx).trim().parse().unwrap_or(0);
        if let Some(at) = date_at(&text(&self.date, cx)) {
            self.form.stop.at = at.min(self.now + 30 * DAY_MS - 60_000);
        }
        self.form.prompt = self.prompt.read(cx).value(cx);
        self.errors.clear();
        self.top_error.clear();
        self.asking = false;
        cx.notify();
    }

    pub(crate) fn dirty(&self) -> bool {
        self.form != self.baseline && !self.created
    }

    /// A change from a picker: the form edited, problems cleared.
    fn update(&mut self, change: impl FnOnce(&mut RoutineForm), cx: &mut Context<Self>) {
        change(&mut self.form);
        self.errors.clear();
        self.top_error.clear();
        let placeholders = placeholders_for(self.form.trigger, self.form.linear.event);
        self.prompt.update(cx, |prompt, cx| prompt.set_placeholders(placeholders, cx));
        cx.notify();
    }

    fn comment(&self) -> bool {
        is_comment(&self.form)
    }

    fn heartbeat(&self) -> bool {
        self.form.run_in == RunIn::Chat && !self.comment()
    }

    pub(crate) fn cancel(&mut self, cx: &mut Context<Self>) {
        if self.dirty() {
            self.asking = true;
            cx.notify();
        } else {
            cx.emit(EditorEvent::Cancel);
        }
    }

    pub(crate) fn save(&mut self, cx: &mut Context<Self>) {
        if self.created {
            return;
        }
        self.pull(cx);
        // A flow has no prompt of its own (its steps have theirs): the checks get a stand-in.
        let mut checked = self.form.clone();
        if self.flow && checked.prompt.trim().is_empty() {
            checked.prompt = "flow".into();
        }
        let fail = |this: &mut Self, error: form::FormError, cx: &mut Context<Self>| {
            // A comment Routine shows no Project or Each Run, so their problems show under the Linear fields.
            let field = if this.comment() && matches!(error.field, Field::Project | Field::RunIn | Field::Chat) {
                Field::Workspace
            } else {
                error.field
            };
            this.errors = HashMap::from([(field, error.error)]);
            cx.notify();
        };
        match self.initial.clone() {
            Some(routine) => match form_to_update(&checked, &routine, self.now) {
                Ok(patch) => cx.emit(EditorEvent::Saved { id: routine.id, patch }),
                Err(error) => fail(self, error, cx),
            },
            None => match form_to_input(&checked, self.now) {
                Ok(input) => {
                    self.created = true;
                    cx.emit(EditorEvent::Created { input, flow: self.flow });
                    cx.notify();
                }
                Err(error) => fail(self, error, cx),
            },
        }
    }

    // ----- pieces -----

    fn error_text(&self, fields: &[Field]) -> Option<String> {
        fields.iter().find_map(|field| self.errors.get(field).cloned())
    }

    fn field_error(&self, fields: &[Field]) -> AnyElement {
        match self.error_text(fields) {
            Some(text) => div().debug_selector(|| "routine-error".into()).child(InlineError::new(text).small()).into_any_element(),
            None => div().into_any_element(),
        }
    }

    fn label(text: &'static str, cx: &App) -> AnyElement {
        div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(cx.theme().ink2).child(text).into_any_element()
    }

    fn labeled(&self, label: &'static str, fields: &[Field], child: impl IntoElement, cx: &App) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .min_w_0()
            .child(Self::label(label, cx))
            .child(child)
            .child(self.field_error(fields))
            .into_any_element()
    }

    /// A picker change as a closure on the editor.
    fn on_pick(
        this: &Entity<Self>,
        change: impl Fn(&mut RoutineForm, &str) + 'static,
    ) -> impl Fn(&SharedString, &mut Window, &mut App) + 'static {
        let this = this.clone();
        move |value, _, cx| {
            let value = value.to_string();
            this.update(cx, |editor, cx| editor.update(|form| change(form, &value), cx));
        }
    }

    fn chip_trigger(id: &'static str, icon: IconName, text: String, invalid: bool, open: bool, theme: Theme) -> AnyElement {
        let chip = Chip::new(id)
            .variant(ChipVariant::Field)
            .on(open)
            .chevron()
            .child(Icon::new(icon).size(IconSize::S14).color(if invalid { theme.red_ink } else { theme.ink2 }))
            .child(div().truncate().child(text));
        if invalid {
            div().rounded_full().border_1().border_color(theme.red).child(chip).into_any_element()
        } else {
            chip.into_any_element()
        }
    }

    fn schedule_panel(&self, this: &Entity<Self>, cx: &App) -> AnyElement {
        let schedule = self.form.schedule.clone();
        let mode_id = |mode| match mode {
            ScheduleMode::Every => "every",
            ScheduleMode::At => "at",
            ScheduleMode::Cron => "cron",
        };
        let timezone = self.labeled(
            "Timezone",
            &[Field::Timezone],
            Select::new(
                "routine-timezone",
                schedule.timezone.clone(),
                std::iter::once(schedule.timezone.as_str())
                    .chain(TIMEZONES.iter().copied().filter(|zone| *zone != schedule.timezone))
                    .map(|zone| SelectOption::new(zone, zone.replace('_', " "))),
            )
            .searchable()
            .width(260.0)
            .on_change(Self::on_pick(this, |form, value| form.schedule.timezone = value.to_string())),
            cx,
        );
        let minutes: &[u32] = &form::EVERY_MINUTES;
        let hours: &[u32] = &form::EVERY_HOURS;
        let steps = if schedule.unit == EveryUnit::Hour { hours } else { minutes };
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(6.0))
            .child(
                Segmented::new(
                    "routine-schedule-mode",
                    Some(mode_id(schedule.mode)),
                    [SegmentedOption::new("every", "Every"), SegmentedOption::new("at", "At a time"), SegmentedOption::new("cron", "Cron")],
                )
                .on_change(Self::on_pick(this, |form, value| {
                    form.schedule.mode = match value {
                        "at" => ScheduleMode::At,
                        "cron" => ScheduleMode::Cron,
                        _ => ScheduleMode::Every,
                    }
                })),
            )
            .when(schedule.mode == ScheduleMode::Every, |el| {
                el.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    Select::new(
                                        "routine-every",
                                        schedule.every.to_string(),
                                        steps.iter().map(|n| SelectOption::new(n.to_string(), n.to_string())),
                                    )
                                    .width(120.0)
                                    .on_change(Self::on_pick(this, |form, value| form.schedule.every = value.parse().unwrap_or(1))),
                                )
                                .child(
                                    Select::new(
                                        "routine-unit",
                                        if schedule.unit == EveryUnit::Hour { "h" } else { "min" },
                                        [SelectOption::new("min", "minutes"), SelectOption::new("h", "hours")],
                                    )
                                    .width(160.0)
                                    .on_change(Self::on_pick(this, |form, value| {
                                        let unit = if value == "h" { EveryUnit::Hour } else { EveryUnit::Min };
                                        // A step the other unit doesn't offer becomes its nearest smaller one.
                                        let steps: &[u32] = if unit == EveryUnit::Hour { &form::EVERY_HOURS } else { &form::EVERY_MINUTES };
                                        if !steps.contains(&form.schedule.every) {
                                            form.schedule.every =
                                                steps.iter().copied().rfind(|s| *s <= form.schedule.every).unwrap_or(steps[0]);
                                        }
                                        form.schedule.unit = unit;
                                    })),
                                ),
                        )
                        .child(self.field_error(&[Field::Schedule])),
                )
            })
            .when(schedule.mode == ScheduleMode::At, |el| {
                let days = schedule.days.clone();
                el.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(div().w(px(104.0)).child(Input::new("routine-time", &self.time).size(FieldSize::S32)))
                                .child(div().flex().gap(px(4.0)).children(DAYS.iter().enumerate().map(|(ix, letter)| {
                                    let on = days.contains(&(ix as u8));
                                    let this = this.clone();
                                    let theme = *cx.theme();
                                    div()
                                        .id(ElementId::from(SharedString::from(format!("routine-day-{}", DAY_NAMES[ix]))))
                                        .debug_selector({
                                            let selector = format!("routine-day-{}", DAY_NAMES[ix]);
                                            move || selector.clone()
                                        })
                                        .flex()
                                        .items_center()
                                        .justify_center()
                                        .size(px(28.0))
                                        .rounded(crate::theme::RADIUS_CONTROL)
                                        .text_step(TEXT_12)
                                        .font_weight(FontWeight::MEDIUM)
                                        .cursor_pointer()
                                        .map(|el| {
                                            if on {
                                                el.bg(theme.ink).text_color(theme.on_ink)
                                            } else {
                                                el.bg(theme.surface)
                                                    .border_1()
                                                    .border_color(theme.line_strong)
                                                    .text_color(theme.ink2)
                                                    .hover(move |s| s.bg(theme.hover))
                                            }
                                        })
                                        .on_click(move |_, _, cx| {
                                            this.update(cx, |editor, cx| {
                                                editor.update(
                                                    |form| {
                                                        let day = ix as u8;
                                                        if form.schedule.days.contains(&day) {
                                                            form.schedule.days.retain(|d| *d != day);
                                                        } else {
                                                            form.schedule.days.push(day);
                                                        }
                                                    },
                                                    cx,
                                                )
                                            })
                                        })
                                        .child(*letter)
                                }))),
                        )
                        .child(self.field_error(&[Field::Schedule])),
                )
                .child(timezone)
            })
            .when(schedule.mode == ScheduleMode::Cron, |el| {
                el.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(Input::new("routine-cron", &self.cron).invalid(self.errors.contains_key(&Field::Schedule)))
                        .child(self.field_error(&[Field::Schedule])),
                )
                .child(self.labeled("Timezone", &[Field::Timezone], div(), cx))
            })
            .into_any_element()
    }

    fn where_panel(&self, this: &Entity<Self>, cx: &App) -> AnyElement {
        let form = &self.form;
        let projects = targets();
        let chats: Vec<(String, String)> =
            projects.iter().find(|project| project.path == form.project_path).map(|project| project.chats.clone()).unwrap_or_default();
        let heartbeat = self.heartbeat();
        let editing = self.editing();
        let run_in = |value: &str| match value {
            "project" => RunIn::Project,
            "chat" => RunIn::Chat,
            _ => RunIn::Worktree,
        };
        let now = self.now;
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .p(px(6.0))
            .child(
                self.labeled(
                    "Project",
                    &[Field::Project],
                    Select::new(
                        "routine-project",
                        form.project_path.clone(),
                        projects.iter().map(|project| {
                            SelectOption::new(project.path.clone(), project.name.clone()).group(model::computer_name(&project.computer))
                        }),
                    )
                    .width(260.0)
                    .on_change(Self::on_pick(this, |form, value| {
                        form.project_path = value.to_string();
                        form.chat_id.clear();
                    })),
                    cx,
                ),
            )
            .child({
                let flow = self.flow;
                let schedule = form.trigger == TriggerKind::Schedule;
                self.labeled(
                    "Each Run",
                    &[Field::RunIn],
                    Select::new(
                        "routine-run-in",
                        match form.run_in {
                            RunIn::Worktree => "worktree",
                            RunIn::Project => "project",
                            RunIn::Chat => "chat",
                        },
                        [
                            SelectOption::new("worktree", "New Worktree")
                                .description("A new Chat in its own Worktree")
                                .disabled(editing && heartbeat),
                            SelectOption::new("project", "Project folder")
                                .description("A new Chat in the Project folder")
                                .disabled(editing && heartbeat),
                            SelectOption::new("chat", "An existing Chat")
                                .description(if flow {
                                    "Not for a flow"
                                } else if schedule {
                                    "A Heartbeat that checks back on one Chat"
                                } else {
                                    "Schedules only"
                                })
                                .disabled(flow || !schedule || (editing && !heartbeat)),
                        ],
                    )
                    .width(280.0)
                    .on_change({
                        let this = this.clone();
                        move |value, _, cx| {
                            let next = run_in(value);
                            this.update(cx, |editor, cx| {
                                let moved = with_run_in(&editor.form, next, now);
                                editor.update(|form| *form = moved, cx);
                            });
                        }
                    }),
                    cx,
                )
            })
            .when(heartbeat, |el| {
                el.child(
                    self.labeled(
                        "Chat",
                        &[Field::Chat],
                        Select::new(
                            "routine-chat",
                            form.chat_id.clone(),
                            if chats.is_empty() {
                                vec![SelectOption::new("", "No Chats").disabled(true)]
                            } else {
                                chats.iter().map(|(id, title)| SelectOption::new(id.clone(), title.clone())).collect()
                            },
                        )
                        .width(280.0)
                        .on_change(Self::on_pick(this, |form, value| form.chat_id = value.to_string())),
                        cx,
                    ),
                )
            })
            .into_any_element()
    }

    fn where_text(&self) -> String {
        if self.heartbeat() {
            let title = fixture::chat_title(&self.form.chat_id);
            return format!("In {}", title.unwrap_or_else(|| "a Chat".into()));
        }
        let project = targets().into_iter().find(|p| p.path == self.form.project_path).map(|p| p.name);
        let project = project.or_else(|| self.form.project_path.rsplit('/').next().filter(|s| !s.is_empty()).map(str::to_string));
        format!(
            "New {} in {}",
            if self.form.run_in == RunIn::Worktree { "Worktree" } else { "Chat" },
            project.unwrap_or_else(|| "a Project".into())
        )
    }

    fn trigger_text(&self) -> String {
        let form = &self.form;
        match form.trigger {
            TriggerKind::Schedule => match form::schedule_cron(&form.schedule) {
                Ok(cron) => trigger_chip_text(&Trigger::Schedule { cron, timezone: form.schedule.timezone.clone() }, Some("UTC")),
                Err(_) => "Schedule".into(),
            },
            TriggerKind::Linear => {
                let opt = |text: &str| (!text.is_empty()).then(|| text.to_string());
                trigger_chip_text(
                    &Trigger::Linear {
                        workspace: form.linear.workspace.clone(),
                        event: form.linear.event,
                        team: opt(&form.linear.team),
                        label: opt(&form.linear.label),
                        state: opt(&form.linear.state),
                    },
                    None,
                )
            }
            TriggerKind::Webhook => "Webhook".into(),
        }
    }

    fn model_options() -> Vec<SelectOption> {
        std::iter::once(SelectOption::new("", "Default model"))
            .chain(model_choices().into_iter().map(|m| SelectOption::new(m.id, m.name).group(m.provider.name())))
            .collect()
    }

    fn fallback_options(&self) -> Vec<SelectOption> {
        std::iter::once(
            SelectOption::new("", "Retry on another provider")
                .description("When a Run fails on its model, it retries once on another installed provider"),
        )
        .chain(
            model_choices().into_iter().map(|m| {
                SelectOption::new(format!("{}:{}", m.provider.id(), m.id), format!("Retry on {}", m.name)).group(m.provider.name())
            }),
        )
        .collect()
    }

    fn mode_options() -> Vec<SelectOption> {
        std::iter::once(SelectOption::new("", "Default mode"))
            .chain(PermissionMode::ALL.into_iter().map(|m| SelectOption::new(m.id(), m.name()).description(m.description())))
            .collect()
    }

    fn linear_rows(&self, this: &Entity<Self>, cx: &App) -> AnyElement {
        let form = &self.form;
        let options = linear_options();
        let pick = |kind: &'static str, value: String, choices: Vec<String>| -> AnyElement {
            let invalid = self.errors.contains_key(&if kind == "Label" { Field::Label } else { Field::State });
            let _ = invalid;
            Select::new(
                if kind == "Label" { "routine-linear-label" } else { "routine-linear-state" },
                value.clone(),
                choices.into_iter().map(|choice| SelectOption::new(choice.clone(), choice)),
            )
            .width(220.0)
            .on_change(Self::on_pick(this, move |form, value| {
                if kind == "Label" {
                    form.linear.label = value.to_string();
                } else {
                    form.linear.state = value.to_string();
                }
            }))
            .into_any_element()
        };
        div()
            .debug_selector(|| "routine-linear".into())
            .flex()
            .gap(px(8.0))
            .child(
                div().flex_1().child(
                    self.labeled(
                        "When",
                        &[],
                        Select::new(
                            "routine-linear-when",
                            form.linear.event.id(),
                            LinearEvent::ALL.iter().map(|event| SelectOption::new(event.id(), event.label())),
                        )
                        .width(200.0)
                        .on_change(Self::on_pick(this, |form, value| {
                            form.linear.event = LinearEvent::from_id(value).unwrap_or(LinearEvent::LabelAdded);
                        })),
                        cx,
                    ),
                ),
            )
            .when(form.linear.event == LinearEvent::LabelAdded, |el| {
                el.child(div().flex_1().child(self.labeled(
                    "Label",
                    &[Field::Label],
                    pick("Label", form.linear.label.clone(), options.labels.clone()),
                    cx,
                )))
            })
            .when(form.linear.event == LinearEvent::State, |el| {
                el.child(div().flex_1().child(self.labeled(
                    "State",
                    &[Field::State],
                    pick("State", form.linear.state.clone(), options.states.clone()),
                    cx,
                )))
            })
            .child(
                div().flex_1().child(
                    self.labeled(
                        "Team",
                        &[Field::Workspace],
                        Select::new(
                            "routine-linear-team",
                            form.linear.team.clone(),
                            std::iter::once(SelectOption::new("", "Any team")).chain(
                                options.teams.iter().map(|(key, name)| SelectOption::new(key.clone(), format!("{key} \u{b7} {name}"))),
                            ),
                        )
                        .width(240.0)
                        .on_change(Self::on_pick(this, |form, value| {
                            form.linear.team = value.to_string();
                            form.linear.label.clear();
                            form.linear.state.clear();
                        })),
                        cx,
                    ),
                ),
            )
            .into_any_element()
    }

    fn webhook_rows(&self, this: &Entity<Self>, cx: &App) -> AnyElement {
        let theme = *cx.theme();
        let signed_before = matches!(self.initial.as_ref().map(|r| &r.trigger), Some(Trigger::Webhook { signed: true, .. }));
        let url = self.initial.as_ref().and_then(|routine| match &routine.trigger {
            Trigger::Webhook { hook_id, .. } => Some(format!("https://relay.milagre.cloud/hooks/{hook_id}")),
            _ => None,
        });
        div()
            .debug_selector(|| "routine-webhook".into())
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(hook_url(url.as_deref(), cx))
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(div().flex_1().child(self.labeled(
                        "Signature header (optional)",
                        &[],
                        Input::new("routine-signature-header", &self.header),
                        cx,
                    )))
                    .child(div().flex_1().child(self.labeled(
                        "Signing secret (optional)",
                        &[Field::SigningSecret],
                        Input::new("routine-signing-secret", &self.secret).invalid(self.errors.contains_key(&Field::SigningSecret)),
                        cx,
                    ))),
            )
            .when(signed_before, |el| {
                let this = this.clone();
                el.child(div().text_step(TEXT_12).text_color(theme.ink2).child(
                    Checkbox::new("routine-check-signature", self.form.webhook.signed).label("Check the signature").on_toggle(
                        move |on, _, cx| {
                            this.update(cx, |editor, cx| {
                                editor.update(|form| form.webhook.signed = on, cx);
                            })
                        },
                    ),
                ))
            })
            .into_any_element()
    }

    fn stop_row(&self, this: &Entity<Self>, cx: &App) -> AnyElement {
        let form = &self.form;
        let heartbeat = self.heartbeat();
        div()
            .mt(px(20.0))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(Self::label("Stop after", cx))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Select::new(
                            "routine-stop",
                            match form.stop.kind {
                                StopKind::Never => "never",
                                StopKind::Runs => "runs",
                                StopKind::Date => "date",
                            },
                            [
                                SelectOption::new("never", "Never").disabled(heartbeat),
                                SelectOption::new("runs", "After a number of Runs"),
                                SelectOption::new("date", "On a date"),
                            ],
                        )
                        .width(220.0)
                        .on_change(Self::on_pick(this, |form, value| {
                            form.stop.kind = match value {
                                "runs" => StopKind::Runs,
                                "date" => StopKind::Date,
                                _ => StopKind::Never,
                            }
                        })),
                    )
                    .when(form.stop.kind == StopKind::Runs, |el| {
                        el.child(div().w(px(90.0)).child(Input::new("routine-stop-runs", &self.runs).size(FieldSize::S32)))
                    })
                    .when(form.stop.kind == StopKind::Date, |el| {
                        el.child(div().w(px(140.0)).child(Input::new("routine-stop-date", &self.date).size(FieldSize::S32)))
                    }),
            )
            .child(self.field_error(&[Field::Stop]))
            .into_any_element()
    }
}

/// The Project a Heartbeat's Chat belongs to (`projectOfKey`): the Chat key is `<path>#<id>`.
fn chat_project(chat_id: &str) -> String {
    chat_id.split('#').next().unwrap_or_default().to_string()
}

impl Render for RoutineEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let this = cx.entity();
        let editing = self.editing();
        let form = self.form.clone();
        let comment = self.comment();
        let first = first_run_at(&form, self.now, &words::ZONE);
        let busy_label = if self.created {
            "Created"
        } else if editing {
            "Save"
        } else if self.flow {
            "Create flow"
        } else {
            "Create Routine"
        };
        let ready = !form.name.trim().is_empty() && (self.flow || !form.prompt.trim().is_empty());
        let asking = self.asking;
        let trigger_icon = match &self.initial {
            Some(routine) => routine_icon(routine),
            None => match form.trigger {
                TriggerKind::Linear => IconName::Tag01,
                TriggerKind::Webhook => IconName::Webhook,
                TriggerKind::Schedule => IconName::Clock01,
            },
        };
        let where_icon = if self.heartbeat() {
            IconName::BubbleChat
        } else if form.run_in == RunIn::Worktree {
            IconName::GitBranch
        } else {
            IconName::Folder01
        };
        let fallback_models = model_choices();
        let fallback_value = if form.fallback_model.is_empty() {
            String::new()
        } else {
            format!("{}:{}", form.fallback_provider.map_or("", Provider::id), form.fallback_model)
        };
        let fallback_efforts: Vec<&'static str> = fallback_models
            .iter()
            .find(|m| Some(m.provider) == form.fallback_provider && m.id == form.fallback_model)
            .map(|m| m.efforts.to_vec())
            .unwrap_or_default();

        let chip_select = |id: &'static str, icon: IconName, value: String, options: Vec<SelectOption>, width: f32, on_change: Pick| {
            let _ = icon;
            Select::new(id, value, options).variant(SelectVariant::Chip).align_start().width(width).on_change(on_change)
        };

        let model_select = chip_select(
            "routine-model",
            IconName::Sparkles,
            form.model.clone(),
            Self::model_options(),
            260.0,
            Box::new(Self::on_pick(&this, |form, value| {
                form.model = value.to_string();
                form.provider = model_choices().into_iter().find(|m| m.id == value).map(|m| m.provider);
            })),
        );
        let fallback_select = fallback_applies(&form).then(|| {
            chip_select(
                "routine-fallback",
                IconName::Refresh,
                fallback_value.clone(),
                self.fallback_options(),
                300.0,
                Box::new(Self::on_pick(&this, |form, value| {
                    let (provider, model) = value.split_once(':').unwrap_or(("", ""));
                    form.fallback_provider = Provider::from_id(provider);
                    form.fallback_model = model.to_string();
                    let keeps = model_choices().into_iter().any(|m| m.id == model && m.efforts.contains(&form.fallback_effort.as_str()));
                    if !keeps {
                        form.fallback_effort.clear();
                    }
                })),
            )
        });
        let effort_select = (fallback_applies(&form)
            && !form.fallback_model.is_empty()
            && (!fallback_efforts.is_empty() || !form.fallback_effort.is_empty()))
        .then(|| {
            let options: Vec<SelectOption> = std::iter::once(SelectOption::new("", "Default effort"))
                .chain(fallback_efforts.iter().map(|e| SelectOption::new(*e, format!("{}{} effort", e[..1].to_uppercase(), &e[1..]))))
                .collect();
            chip_select(
                "routine-fallback-effort",
                IconName::Refresh,
                form.fallback_effort.clone(),
                options,
                200.0,
                Box::new(Self::on_pick(&this, |form, value| form.fallback_effort = value.to_string())),
            )
        });
        let mode_select = chip_select(
            "routine-mode",
            IconName::SecurityCheck,
            form.permission_mode.clone(),
            Self::mode_options(),
            320.0,
            Box::new(Self::on_pick(&this, |form, value| form.permission_mode = value.to_string())),
        );

        let schedule_chip = if form.trigger == TriggerKind::Schedule {
            let content_this = this.clone();
            let (text, invalid) =
                (self.trigger_text(), self.errors.contains_key(&Field::Schedule) || self.errors.contains_key(&Field::Timezone));
            Popover::new("routine-schedule")
                .align_start()
                .width(px(340.0))
                .trigger(move |open| Self::chip_trigger("routine-chip-schedule", trigger_icon, text.clone(), invalid, open, theme))
                .content(move |_dismiss, _window, cx| {
                    let editor = content_this.clone();
                    editor.read(cx).schedule_panel(&editor, cx)
                })
                .into_any_element()
        } else {
            Chip::new("routine-chip-trigger")
                .variant(ChipVariant::Static)
                .child(Icon::new(trigger_icon).size(IconSize::S14).color(theme.ink2))
                .child(div().truncate().child(self.trigger_text()))
                .into_any_element()
        };
        let where_chip = (!comment).then(|| {
            let content_this = this.clone();
            let (text, invalid) = (
                self.where_text(),
                self.errors.contains_key(&Field::Project)
                    || self.errors.contains_key(&Field::RunIn)
                    || self.errors.contains_key(&Field::Chat),
            );
            Popover::new("routine-where")
                .align_start()
                .width(px(300.0))
                .trigger(move |open| Self::chip_trigger("routine-chip-where", where_icon, text.clone(), invalid, open, theme))
                .content(move |_dismiss, _window, cx| {
                    let editor = content_this.clone();
                    editor.read(cx).where_panel(&editor, cx)
                })
        });

        let discard = asking.then(|| {
            let (keep, discard) = (this.clone(), this.clone());
            div()
                .debug_selector(|| "routine-discard".into())
                .mt(px(12.0))
                .flex()
                .items_center()
                .gap(px(12.0))
                .px(px(16.0))
                .py(px(8.0))
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(theme.line)
                .child(div().flex_1().min_w_0().text_step(TEXT_13).text_color(theme.ink).child("Discard your changes to this Routine?"))
                .child(
                    Button::new("routine-discard-keep", "Keep editing").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                        act_editor(&keep, |editor, cx| {
                            editor.asking = false;
                            cx.notify();
                        }),
                    ),
                )
                .child(
                    Button::new("routine-discard-confirm", "Discard")
                        .variant(ButtonVariant::Danger)
                        .size(ButtonSize::S28)
                        .on_click(act_editor(&discard, |_, cx| cx.emit(EditorEvent::Cancel))),
                )
        });

        let delete = self.initial.clone().map(|routine| {
            let (start, cancel, confirm) = (this.clone(), this.clone(), this.clone());
            let id = routine.id.clone();
            let confirming = self.confirming;
            div()
                .debug_selector(|| "routine-delete".into())
                .mt(px(32.0))
                .flex()
                .items_center()
                .gap(px(12.0))
                .min_h(px(48.0))
                .px(px(16.0))
                .py(px(8.0))
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(theme.line)
                .child(div().flex_1().min_w_0().text_step(TEXT_12).text_color(theme.ink2).child(if confirming {
                    format!("Delete {}? {}", routine.name, delete_warning(&routine))
                } else {
                    delete_warning(&routine).to_string()
                }))
                .map(|el| {
                    if confirming {
                        el.child(
                            Button::new("routine-delete-cancel", "Cancel")
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S28)
                                .on_click(act_editor(&cancel, |editor, cx| {
                                    editor.confirming = false;
                                    cx.notify();
                                })),
                        )
                        .child(
                            Button::new("routine-delete-confirm", "Delete")
                                .variant(ButtonVariant::Danger)
                                .size(ButtonSize::S28)
                                .on_click(act_editor(&confirm, move |_, cx| cx.emit(EditorEvent::Deleted { id: id.clone() }))),
                        )
                    } else {
                        el.child(
                            Button::new("routine-delete-start", "Delete Routine")
                                .variant(ButtonVariant::DangerGhost)
                                .size(ButtonSize::S28)
                                .icon(IconName::Delete02)
                                .on_click(act_editor(&start, |editor, cx| {
                                    editor.confirming = true;
                                    cx.notify();
                                })),
                        )
                    }
                })
        });

        let body = div()
            .id("routine-form")
            .debug_selector(|| "routine-form".into())
            .flex()
            .flex_col()
            .flex_1()
            .w_full()
            .when(!self.embedded, |el| el.max_w(px(FORM_WIDTH)).px(px(24.0)).pt(px(12.0)).pb(px(40.0)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(div().flex_1().min_w_0().child(Input::new("routine-name", &self.name).invalid(self.errors.contains_key(&Field::Name))))
                    .child(Button::new("routine-cancel", "Cancel").variant(ButtonVariant::Secondary).on_click(act_editor(&this, |editor, cx| editor.cancel(cx))))
                    .child(
                        Button::new("routine-save", busy_label)
                            .disabled(self.created || (!editing && !ready))
                            .on_click(act_editor(&this, |editor, cx| editor.save(cx))),
                    ),
            )
            .child(self.field_error(&[Field::Name]))
            .children(discard)
            .when(!self.top_error.is_empty(), |el| el.child(div().mt(px(12.0)).child(InlineError::new(self.top_error.clone()).small())))
            .when(!editing, |el| {
                let (flow_this, trigger_this) = (this.clone(), this.clone());
                el.child(
                    div()
                        .mt(px(20.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(Self::label("Runs", cx))
                        .child(
                            Segmented::new(
                                "routine-runs-kind",
                                Some(if self.flow { "flow" } else { "prompt" }),
                                [SegmentedOption::new("prompt", "Single prompt").icon(IconName::Text), SegmentedOption::new("flow", "Flow").icon(IconName::Split)],
                            )
                            .large()
                            .on_change(move |value, _, cx| {
                                let on = value.as_ref() == "flow";
                                flow_this.update(cx, |editor, cx| {
                                    editor.flow = on;
                                    if on && editor.form.run_in == RunIn::Chat {
                                        let moved = with_run_in(&editor.form, RunIn::Worktree, editor.now);
                                        editor.update(|form| *form = moved, cx);
                                    }
                                    editor.errors.clear();
                                    cx.notify();
                                })
                            }),
                        ),
                )
                .child(
                    div()
                        .mt(px(16.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(Self::label("Starts", cx))
                        .child(
                            Segmented::new(
                                "routine-starts",
                                Some(match form.trigger {
                                    TriggerKind::Schedule => "schedule",
                                    TriggerKind::Linear => "linear",
                                    TriggerKind::Webhook => "webhook",
                                }),
                                [
                                    SegmentedOption::new("schedule", "On a schedule").icon(IconName::Clock01),
                                    SegmentedOption::new("linear", "Linear event").icon(IconName::Tag01),
                                    SegmentedOption::new("webhook", "Webhook").icon(IconName::Webhook),
                                ],
                            )
                            .large()
                            .on_change(Self::on_pick(&trigger_this, |form, value| {
                                form.trigger = match value {
                                    "linear" => TriggerKind::Linear,
                                    "webhook" => TriggerKind::Webhook,
                                    _ => TriggerKind::Schedule,
                                };
                                // Only a schedule can check back on a Chat.
                                if form.trigger != TriggerKind::Schedule && form.run_in == RunIn::Chat {
                                    form.run_in = RunIn::Worktree;
                                }
                                if form.trigger == TriggerKind::Linear && form.linear.workspace.is_empty() {
                                    form.linear.workspace = "milagre".into();
                                }
                            })),
                        )
                        .child(self.field_error(&[Field::Trigger])),
                )
            })
            .child(
                div()
                    .debug_selector(|| "routine-chips".into())
                    .mt(px(16.0))
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.0))
                    .child(schedule_chip)
                    .children(where_chip)
                    .child(model_select)
                    .children(fallback_select)
                    .children(effort_select)
                    .child(mode_select),
            )
            .child(div().mt(px(6.0)).flex().flex_col().gap(px(4.0)).child(self.field_error(&[Field::Schedule, Field::Timezone])).child(self.field_error(&[Field::Project, Field::RunIn, Field::Chat])))
            .when(form.trigger == TriggerKind::Linear, |el| el.child(div().mt(px(12.0)).child(self.linear_rows(&this, cx))))
            .when(form.trigger == TriggerKind::Webhook, |el| el.child(div().mt(px(12.0)).child(self.webhook_rows(&this, cx))))
            .when(comment, |el| {
                el.child(div().debug_selector(|| "routine-comment-note".into()).mt(px(12.0)).text_step(TEXT_12).text_color(theme.ink2).child("Comments go into the Chat linked to the issue."))
            })
            .when(self.flow && !editing, |el| {
                el.child(div().debug_selector(|| "routine-flow-note".into()).mt(px(24.0)).text_step(TEXT_12).text_color(theme.ink2).child(
                    "You add the steps after you create it: agents, conditions, approvals, waits and actions. A flow stays off until you publish it.",
                ))
            })
            .when(!self.flow, |el| {
                self.prompt.update(cx, |prompt, cx| prompt.set_invalid(self.errors.contains_key(&Field::Prompt), cx));
                el.child(
                    div()
                        .mt(px(24.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(Self::label("Prompt", cx))
                        .child(self.prompt.clone())
                        .child(div().debug_selector(|| "routine-prompt-hint".into()).text_step(TEXT_12).text_color(theme.ink3).child(prompt_hint(form.trigger)))
                        .child(self.field_error(&[Field::Prompt])),
                )
            })
            .child(self.stop_row(&this, cx))
            .children(delete)
            .when(!editing && !self.flow, |el| {
                el.child(
                    div()
                        .debug_selector(|| "routine-runs-placeholder".into())
                        .mt(px(32.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .child(SectionLabel::new("Runs"))
                        .child(div().text_step(TEXT_12).text_color(theme.ink3).child(format!(
                            "Runs show here once the Routine is created.{}",
                            match (form.trigger, first) {
                                (TriggerKind::Schedule, Some(at)) => format!(" The first one starts at {}.", clock(at, &words::ZONE)),
                                _ => String::new(),
                            }
                        ))),
                )
            });

        if self.embedded {
            return div().flex().flex_col().flex_1().min_w_0().child(body).into_any_element();
        }
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(theme.page)
            .child(chrome::header("routine-editor-header"))
            .child(div().flex_1().min_h_0().child(
                ScrollArea::new("routine-form-scroll", &self.scroll).child(div().w_full().flex().flex_1().justify_center().child(body)),
            ))
            .into_any_element()
    }
}

/// A click handler on the editor.
fn act_editor(
    editor: &Entity<RoutineEditor>,
    f: impl Fn(&mut RoutineEditor, &mut Context<RoutineEditor>) + 'static,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let editor = editor.clone();
    move |_, _, cx| editor.update(cx, |this, cx| f(this, cx))
}

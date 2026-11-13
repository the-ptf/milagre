//! Settings › Integrations › Babysit PRs (`BabysitPrsSettings.tsx`, `lib/babysit-settings.ts`): the one
//! configuration every Chat's babysitting follows. Switches, menus and chips save at once; the two typed fields
//! save shortly after typing stops and when they lose focus. The fixture [`BabysitHost`] stands in for
//! `babysit:settings:*`.

use std::time::Duration;

use gpui::{
    AnyElement, ClickEvent, Context, Entity, FontWeight, IntoElement, ParentElement, SharedString, Styled, Subscription, Task, Window, div,
    prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState, TextareaState};

use super::IntegrationsView;
use super::babysit_model::{
    Babysit, Change, DAYS_OPTIONS, DEFAULT_LEVEL, FAILURE_OPTIONS, INSTRUCTIONS_MAX, INTERVAL_OPTIONS, LEVELS, OWN_RULE_MAX, SaveState,
    Step, Wake, plural,
};
use crate::settings::group::{CheckboxRow, SettingRow};
use crate::settings::mcp::{ToggleFn, radio_dot};
use crate::theme::{ActiveTheme, TEXT_11, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Checkbox, FieldSize, Icon, IconName, IconSize, InlineError, Input, Select, SelectOption, TextArea,
};

/// How long typing must pause before a typed field saves (`createDebouncedSave`).
pub const AUTOSAVE_MS: u64 = 500;
/// How long the fixture host takes to save.
pub const SAVE_MS: u64 = 80;

/// The fixture standing in for the daemon's copy of the settings.
#[derive(Clone, Debug, Default)]
pub struct BabysitHost {
    pub saved: Babysit,
    /// Every save fails (a test hook).
    pub fail: bool,
    pub writes: u32,
}

impl BabysitHost {
    fn write(&mut self, settings: &Babysit) -> Result<(), String> {
        if self.fail {
            return Err("Could not reach the computer.".to_string());
        }
        self.saved = settings.clone().normalized();
        self.writes += 1;
        Ok(())
    }
}

/// A typed field that saves itself shortly after typing stops and when it loses focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    OwnRule,
    Instructions,
}

#[derive(Clone, Copy, Debug)]
struct FieldSave {
    dirty: bool,
    state: SaveState,
    run: u64,
}

impl FieldSave {
    fn new(saved: bool) -> Self {
        Self { dirty: false, state: if saved { SaveState::Saved } else { SaveState::Idle }, run: 0 }
    }
}

pub struct BabysitState {
    pub settings: Babysit,
    pub host: BabysitHost,
    pub error: String,
    own_rule: Option<Entity<InputState>>,
    instructions: Option<Entity<TextareaState>>,
    own_save: FieldSave,
    instructions_save: FieldSave,
    _subs: Vec<Subscription>,
}

impl Default for BabysitState {
    fn default() -> Self {
        let host = BabysitHost::default();
        Self {
            settings: host.saved.clone(),
            host,
            error: String::new(),
            own_rule: None,
            instructions: None,
            own_save: FieldSave::new(false),
            instructions_save: FieldSave::new(false),
            _subs: Vec::new(),
        }
    }
}

impl BabysitState {
    pub fn field_state(&self, field: Field) -> SaveState {
        match field {
            Field::OwnRule => self.own_save.state,
            Field::Instructions => self.instructions_save.state,
        }
    }

    pub fn own_rule_input(&self) -> Option<Entity<InputState>> {
        self.own_rule.clone()
    }

    pub fn instructions_input(&self) -> Option<Entity<TextareaState>> {
        self.instructions.clone()
    }

    fn save_of(&mut self, field: Field) -> &mut FieldSave {
        match field {
            Field::OwnRule => &mut self.own_save,
            Field::Instructions => &mut self.instructions_save,
        }
    }
}

impl IntegrationsView {
    /// The two typed fields are created the first time the page draws.
    pub(super) fn ensure_babysit_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.babysit.own_rule.is_some() {
            return;
        }
        let own_rule = Input::state("", window, cx);
        let instructions = TextArea::state("", (5, 10), window, cx);
        let text = self.babysit.settings.clone();
        own_rule.update(cx, |state, cx| state.set_value(text.own_rule_text.clone(), window, cx));
        instructions.update(cx, |state, cx| state.set_value(text.instructions.clone(), window, cx));
        self.babysit.own_save = FieldSave::new(!text.own_rule_text.is_empty());
        self.babysit.instructions_save = FieldSave::new(!text.instructions.is_empty());
        let subs = vec![
            cx.subscribe(&own_rule, |this, input, event: &InputEvent, cx| {
                this.typed_event(Field::OwnRule, input.read(cx).value().to_string(), event, cx)
            }),
            cx.subscribe(&instructions, |this, input, event: &InputEvent, cx| {
                this.typed_event(Field::Instructions, input.read(cx).value().to_string(), event, cx)
            }),
        ];
        self.babysit.own_rule = Some(own_rule);
        self.babysit.instructions = Some(instructions);
        self.babysit._subs = subs;
    }

    fn typed_event(&mut self, field: Field, text: String, event: &InputEvent, cx: &mut Context<Self>) {
        match event {
            InputEvent::Change => {
                match field {
                    Field::OwnRule => self.babysit.settings.own_rule_text = text.chars().take(OWN_RULE_MAX).collect(),
                    Field::Instructions => self.babysit.settings.instructions = text.chars().take(INSTRUCTIONS_MAX).collect(),
                }
                // Typing takes the Saved mark away until this text has saved.
                let save = self.babysit.save_of(field);
                save.dirty = true;
                save.state = SaveState::Idle;
                save.run += 1;
                let run = save.run;
                cx.notify();
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(AUTOSAVE_MS)).await;
                    this.update(cx, |this, cx| {
                        if this.babysit.save_of(field).run == run {
                            this.flush_field(field, cx);
                        }
                    })
                    .ok();
                })
                .detach();
            }
            InputEvent::Blur => self.flush_field(field, cx),
            _ => {}
        }
    }

    /// Saves what was typed last, now.
    pub fn flush_field(&mut self, field: Field, cx: &mut Context<Self>) {
        let save = self.babysit.save_of(field);
        if !save.dirty {
            return;
        }
        save.run += 1;
        save.state = SaveState::Saving;
        let run = save.run;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SAVE_MS)).await;
            // The latest settings go, so writes that land out of order never leave an old one behind.
            let Ok(write) = this.update(cx, |this, cx| this.write_babysit(cx)) else { return };
            let result = write.await;
            this.update(cx, |this, cx| {
                let save = this.babysit.save_of(field);
                if save.run != run {
                    return;
                }
                match result {
                    Ok(()) => {
                        save.state = SaveState::Saved;
                        save.dirty = false;
                    }
                    Err(_) => save.state = SaveState::Error,
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Writes the latest settings: to the fixture host, or with a data layer `babysit:settings:save [patch]` of what
    /// differs from the host's copy, which its answer then replaces.
    fn write_babysit(&mut self, cx: &mut Context<Self>) -> Task<Result<(), String>> {
        let settings = self.babysit.settings.clone();
        if crate::settings::host::host(cx).is_none() {
            return Task::ready(self.babysit.host.write(&settings));
        }
        let patch = settings.patch_from(&self.babysit.host.saved);
        if patch.is_empty() {
            return Task::ready(Ok(()));
        }
        let Some(task) = crate::settings::host::call("babysit:settings:save", serde_json::json!([patch]), cx) else {
            return Task::ready(Ok(()));
        };
        cx.spawn(async move |this, cx| {
            let saved = Babysit::from_json(&task.await?);
            this.update(cx, |this, _| {
                this.babysit.host.saved = saved;
                this.babysit.host.writes += 1;
            })
            .map_err(|_| "Settings closed.".to_string())
        })
    }

    /// `babysit:settings:read` (a data layer only): the page shows what the host keeps; typed text not saved yet stays.
    pub(super) fn read_babysit(&mut self, cx: &mut Context<Self>) {
        let Some(task) = crate::settings::host::call("babysit:settings:read", serde_json::json!([]), cx) else { return };
        cx.spawn(async move |this, cx| {
            let answer = task.await;
            this.update(cx, |this, cx| {
                match answer {
                    Ok(value) => {
                        let saved = Babysit::from_json(&value);
                        let mut shown = saved.clone();
                        if this.babysit.own_save.dirty {
                            shown.own_rule_text = this.babysit.settings.own_rule_text.clone();
                        }
                        if this.babysit.instructions_save.dirty {
                            shown.instructions = this.babysit.settings.instructions.clone();
                        }
                        this.babysit.host.saved = saved;
                        this.babysit.settings = shown;
                        this.babysit.error.clear();
                        // The typed fields follow the host's text the next time they are made.
                        this.babysit.own_rule = None;
                        this.babysit.instructions = None;
                    }
                    Err(_) => this.babysit.error = "Could not read the Babysit PRs settings.".into(),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Leaving the page saves what was typed last.
    pub fn flush_all(&mut self, cx: &mut Context<Self>) {
        self.flush_field(Field::OwnRule, cx);
        self.flush_field(Field::Instructions, cx);
    }

    /// Switches, menus and chips save at once; a failure shows in the page's error line and the page goes back to
    /// what the host holds.
    pub fn change(&mut self, change: Change, cx: &mut Context<Self>) {
        self.babysit.error.clear();
        change(&mut self.babysit.settings);
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SAVE_MS)).await;
            let Ok(write) = this.update(cx, |this, cx| this.write_babysit(cx)) else { return };
            let result = write.await;
            this.update(cx, |this, cx| {
                if let Err(message) = result {
                    this.babysit.error = message;
                    let keep_text = (this.babysit.settings.own_rule_text.clone(), this.babysit.settings.instructions.clone());
                    this.babysit.settings = this.babysit.host.saved.clone();
                    this.babysit.settings.own_rule_text = keep_text.0;
                    this.babysit.settings.instructions = keep_text.1;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Reset all to defaults: drops what was typed, leaves the fields and shows the defaults.
    pub fn reset_babysit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for field in [Field::OwnRule, Field::Instructions] {
            let save = self.babysit.save_of(field);
            save.run += 1;
            save.dirty = false;
            save.state = SaveState::Idle;
        }
        if let Some(input) = self.babysit.own_rule.clone() {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        if let Some(input) = self.babysit.instructions.clone() {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        self.change(Box::new(|settings| *settings = Babysit::default()), cx);
    }

    pub fn toggle_wake(&mut self, kind: Wake, cx: &mut Context<Self>) {
        self.change(
            Box::new(move |settings| {
                let on = if settings.wake.contains(&kind) {
                    settings.wake.iter().copied().filter(|item| *item != kind).collect::<Vec<_>>()
                } else {
                    let mut next = settings.wake.clone();
                    next.push(kind);
                    next
                };
                settings.wake = Wake::ALL.into_iter().filter(|item| on.contains(item)).collect();
            }),
            cx,
        );
    }
}

// ---- drawing ------------------------------------------------------------------------------------------------------

fn options(values: &[u32], one: &str, many: &str) -> Vec<SelectOption> {
    values.iter().map(|value| SelectOption::new(value.to_string(), plural(*value, one, many))).collect()
}

fn step_icon(step: Step) -> IconName {
    match step {
        Step::Report => IconName::File01,
        Step::Fix => IconName::Wrench01,
        Step::Push => IconName::Upload01,
        Step::Reply => IconName::Message01,
        Step::Rerequest => IconName::UserCheck01,
    }
}

fn step_pill(steps: &[Step], selected: bool, theme: &Theme) -> AnyElement {
    let ink = if selected { theme.ink } else { theme.ink2 };
    let mut pill = div().flex().flex_none().items_center().gap(px(2.0)).h(px(24.0)).px(px(6.0)).rounded_full().bg(theme.field);
    for (ix, step) in steps.iter().enumerate() {
        if ix > 0 {
            pill = pill.child(Icon::new(IconName::ArrowRight01).size(IconSize::S12).color(theme.ink3));
        }
        pill = pill.child(Icon::new(step_icon(*step)).size(IconSize::S14).color(ink));
    }
    pill.into_any_element()
}

fn group_header(title: &'static str, action: Option<AnyElement>, found: bool, theme: &Theme) -> AnyElement {
    div()
        .px(px(4.0))
        .mb(px(6.0))
        .flex()
        .items_center()
        .justify_between()
        .child(
            div()
                .rounded(crate::theme::RADIUS_CONTROL)
                .when(found, |d| d.bg(theme.hover2).debug_selector(|| "settings-found-row".into()))
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .child(title),
        )
        .children(action)
        .into_any_element()
}

fn card(theme: &Theme, rows: Vec<AnyElement>) -> AnyElement {
    let mut card =
        div().rounded(crate::theme::RADIUS_CARD).border_1().border_color(theme.line).bg(theme.inset).overflow_hidden().flex().flex_col();
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            card = card.child(div().w_full().h(px(1.0)).bg(theme.line));
        }
        card = card.child(row);
    }
    card.into_any_element()
}

fn save_mark(state: SaveState, theme: &Theme) -> AnyElement {
    match state {
        SaveState::Error => div()
            .debug_selector(|| "babysit-not-saved".into())
            .text_step(TEXT_12)
            .text_color(theme.red_ink)
            .child("Not saved")
            .into_any_element(),
        SaveState::Saving => div().text_step(TEXT_12).text_color(theme.ink3).child("Saving…").into_any_element(),
        SaveState::Idle => div().into_any_element(),
        SaveState::Saved => div()
            .debug_selector(|| "babysit-saved".into())
            .flex()
            .items_center()
            .gap(px(4.0))
            .text_step(TEXT_12)
            .text_color(theme.ink3)
            .child(Icon::new(IconName::Tick02).size(IconSize::S12).color(theme.ink3))
            .child("Saved")
            .into_any_element(),
    }
}

impl IntegrationsView {
    /// A stop rule: its checkbox first, then what it says, then its number or note.
    #[allow(clippy::too_many_arguments)]
    fn stop_row(
        &self,
        id: &'static str,
        label: &'static str,
        description: Option<&'static str>,
        checked: bool,
        disabled: bool,
        on_change: Option<ToggleFn>,
        trailing: Option<AnyElement>,
        extra: Option<AnyElement>,
        theme: &Theme,
    ) -> AnyElement {
        let mut checkbox = Checkbox::new(id, checked).disabled(disabled);
        if let Some(handler) = on_change {
            checkbox = checkbox.on_toggle(handler);
        }
        div()
            .debug_selector(move || format!("{id}-row"))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(16.0))
            .py(px(12.0))
            .child(
                div()
                    .min_h(px(24.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(checkbox)
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(label))
                            .children(description.map(|text| div().text_step(TEXT_12).text_color(theme.ink3).child(text))),
                    )
                    .children(trailing.map(|el| div().flex_none().text_step(TEXT_13).text_color(theme.ink3).child(el))),
            )
            .children(extra)
            .into_any_element()
    }

    pub(super) fn babysit_form(&mut self, found: Option<&str>, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.ensure_babysit_inputs(window, cx);
        let theme = *cx.theme();
        let s = self.babysit.settings.clone();
        let page = cx.entity();
        let found_group = |title: &str| found == Some(title);

        let reset = Button::new("babysit-reset", "Reset all to defaults")
            .variant(ButtonVariant::Link)
            .size(ButtonSize::S24)
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.reset_babysit(window, cx)))
            .into_any_element();

        // ---- Babysit PRs
        let interval = {
            let page = page.clone();
            Select::new("babysit-interval", s.interval_minutes.to_string(), options(&INTERVAL_OPTIONS, "minute", "minutes"))
                .width(140.0)
                .on_change(move |value, _, cx| {
                    let minutes: u32 = value.parse().unwrap_or(1);
                    page.update(cx, |this, cx| this.change(Box::new(move |s| s.interval_minutes = minutes), cx))
                })
        };
        let wake_chips = Wake::ALL.into_iter().map(|kind| {
            let on = s.wake.contains(&kind);
            let (fg, weight) = if on { (theme.on_ink, FontWeight::SEMIBOLD) } else { (theme.ink2, FontWeight::MEDIUM) };
            div()
                .id(SharedString::from(format!("babysit-wake-{}", kind.id())))
                .debug_selector(move || format!("babysit-wake-{}", kind.id()))
                .h(px(28.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .pl(px(8.0))
                .pr(px(10.0))
                .rounded_full()
                .cursor_pointer()
                .text_step(TEXT_12)
                .font_weight(weight)
                .text_color(fg)
                .when(on, |d| d.bg(theme.ink))
                .when(!on, |d| d.bg(theme.surface).shadow(theme.shadow_btn()).hover(|s| s.text_color(theme.ink)))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle_wake(kind, cx)))
                .child(Icon::new(if on { IconName::Tick02 } else { IconName::Add01 }).size(IconSize::S14).color(fg))
                .child(kind.label())
        });
        let main_rows = vec![
            CheckboxRow::new("babysit-enabled", "Babysit new PRs", s.enabled)
                .description("Off by default. When a Chat opens a PR, Milagre adds a Heartbeat to that Chat and watches the PR until it's done.")
                .highlighted(found)
                .on_change({
                    let page = page.clone();
                    move |enabled, _, cx| page.update(cx, |this, cx| this.change(Box::new(move |s| s.enabled = enabled), cx))
                })
                .into_any_element(),
            SettingRow::new("Check every")
                .description("Milagre asks GitHub itself on this interval. The agent only wakes when something new shows up, so idle PRs cost nothing.")
                .highlighted(found)
                .control(interval)
                .into_any_element(),
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .px(px(16.0))
                .py(px(12.0))
                .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Wake the agent for"))
                .child(div().flex().flex_wrap().gap(px(6.0)).children(wake_chips))
                .into_any_element(),
        ];

        // ---- When something needs fixing
        let level_rows: Vec<AnyElement> = LEVELS
            .iter()
            .map(|entry| {
                let selected = entry.level == s.level;
                let level = entry.level;
                div()
                    .id(SharedString::from(format!("babysit-level-{level}")))
                    .debug_selector(move || format!("babysit-level-{level}"))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(crate::theme::RADIUS_INLINE)
                    .cursor_pointer()
                    .hover(|st| st.bg(theme.hover))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.change(Box::new(move |s| s.level = level), cx)))
                    .child(radio_dot(selected, &theme))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .text_step(TEXT_13)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .child(entry.title)
                                    .when(entry.level == DEFAULT_LEVEL, |d| {
                                        d.child(
                                            div()
                                                .rounded(crate::theme::RADIUS_INLINE)
                                                .bg(theme.field)
                                                .px(px(6.0))
                                                .py(px(1.0))
                                                .text_step(TEXT_11)
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(theme.ink2)
                                                .child("Default"),
                                        )
                                    }),
                            )
                            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(entry.description)),
                    )
                    .child(step_pill(entry.steps, selected, &theme))
                    .into_any_element()
            })
            .collect();
        let fixing_rows = vec![
            div().p(px(6.0)).flex().flex_col().children(level_rows).into_any_element(),
            CheckboxRow::new("babysit-resolve", "Resolve threads it answered", s.resolve_threads)
                .description("On by default. After replying on a thread, the agent marks it resolved.")
                .highlighted(found)
                .on_change({
                    let page = page.clone();
                    move |on, _, cx| page.update(cx, |this, cx| this.change(Box::new(move |s| s.resolve_threads = on), cx))
                })
                .into_any_element(),
        ];

        // ---- Stop babysitting when
        let days_select = {
            let page = page.clone();
            Select::new("babysit-days", s.stop_after_days.value.to_string(), options(&DAYS_OPTIONS, "day", "days"))
                .width(120.0)
                .disabled(!s.stop_after_days.on)
                .on_change(move |value, _, cx| {
                    let days: u32 = value.parse().unwrap_or(7);
                    page.update(cx, |this, cx| this.change(Box::new(move |s| s.stop_after_days.value = days), cx))
                })
        };
        let failures_select = {
            let page = page.clone();
            Select::new("babysit-failures", s.stop_after_failures.value.to_string(), options(&FAILURE_OPTIONS, "time", "times"))
                .width(120.0)
                .disabled(!s.stop_after_failures.on)
                .on_change(move |value, _, cx| {
                    let times: u32 = value.parse().unwrap_or(3);
                    page.update(cx, |this, cx| this.change(Box::new(move |s| s.stop_after_failures.value = times), cx))
                })
        };
        let own_rule_extra = s.own_rule.then(|| {
            let input = self.babysit.own_rule.clone().expect("created above");
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(Input::new("babysit-own-rule-input", &input).size(FieldSize::S36))
                .child(InlineError::new(if self.babysit.own_save.state == SaveState::Error { "Not saved" } else { "" }).small())
                .into_any_element()
        });
        let on_change = |apply: fn(&mut Babysit, bool)| -> ToggleFn {
            let page = page.clone();
            Box::new(move |on, _, cx| page.update(cx, |this, cx| this.change(Box::new(move |s| apply(s, on)), cx)))
        };
        let stop_rows = vec![
            self.stop_row(
                "babysit-stop-closed",
                "The PR is merged or closed",
                None,
                true,
                true,
                None,
                Some(div().child("Always").into_any_element()),
                None,
                &theme,
            ),
            self.stop_row(
                "babysit-stop-green",
                "Checks pass and the PR is approved",
                Some("Nothing left to address. A comment that lands after this goes unwatched."),
                s.stop_when_green,
                false,
                Some(on_change(|s, on| s.stop_when_green = on)),
                None,
                None,
                &theme,
            ),
            self.stop_row(
                "babysit-stop-days",
                "It has watched the PR for",
                None,
                s.stop_after_days.on,
                false,
                Some(on_change(|s, on| s.stop_after_days.on = on)),
                Some(days_select.into_any_element()),
                None,
                &theme,
            ),
            self.stop_row(
                "babysit-stop-failures",
                "It failed to fix the same problem",
                None,
                s.stop_after_failures.on,
                false,
                Some(on_change(|s, on| s.stop_after_failures.on = on)),
                Some(failures_select.into_any_element()),
                None,
                &theme,
            ),
            self.stop_row(
                "babysit-stop-own",
                "Your own rule",
                Some("The agent checks it each time it wakes and ends the Heartbeat when it holds."),
                s.own_rule,
                false,
                Some(on_change(|s, on| s.own_rule = on)),
                None,
                own_rule_extra,
                &theme,
            ),
        ];

        // ---- Your instructions
        let instructions = self.babysit.instructions.clone().expect("created above");
        let instructions_rows = vec![
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .p(px(16.0))
                .child(TextArea::new("babysit-instructions", &instructions))
                .child(div().min_h(px(16.0)).flex().justify_end().child(save_mark(self.babysit.instructions_save.state, &theme)))
                .into_any_element(),
        ];

        let group = |title: &'static str, action: Option<AnyElement>, rows: Vec<AnyElement>, footer: Option<&'static str>| {
            div()
                .mb(px(24.0))
                .flex()
                .flex_col()
                .child(group_header(title, action, found_group(title), &theme))
                .child(card(&theme, rows))
                .children(footer.map(|text| div().mt(px(8.0)).px(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(text)))
                .into_any_element()
        };
        div()
            .flex()
            .flex_col()
            .child(group("Babysit PRs", Some(reset), main_rows, None))
            .child(group(
                "When something needs fixing",
                None,
                fixing_rows,
                Some("Each PR keeps the settings it started with: changes here apply to PRs opened afterwards."),
            ))
            .child(group("Stop babysitting when", None, stop_rows, None))
            .child(group("Your instructions", None, instructions_rows, None))
            .into_any_element()
    }

    /// The Integrations › Babysit PRs row: whether babysitting is on, and the way into its page.
    pub(super) fn babysit_row(&self, found: Option<&str>, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let highlighted = found == Some("Babysit PRs");
        div()
            .id("babysit-prs-row")
            .debug_selector(move || if highlighted { "settings-found-row".to_string() } else { "babysit-prs-row".to_string() })
            .min_h(px(48.0))
            .flex()
            .items_center()
            .justify_between()
            .gap(px(24.0))
            .px(px(16.0))
            .py(px(8.0))
            .cursor_pointer()
            .when(highlighted, |d| d.bg(theme.hover2))
            .hover(move |s| s.bg(theme.hover))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.open_babysit(cx)))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Babysit PRs"))
                    .child(
                        div()
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child("Watch every PR a Chat opens and fix review comments, failed checks and conflicts."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child(if self.babysit.settings.enabled { "On" } else { "Off" })
                    .child(Icon::new(IconName::ArrowRight01).size(IconSize::S16).color(theme.ink3)),
            )
            .into_any_element()
    }
}

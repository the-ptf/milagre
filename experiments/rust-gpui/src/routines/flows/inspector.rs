//! The selected step's settings (R-07: `FlowInspector.tsx`): a card with the step's tile, name and kind, its problems on
//! top, then a form by type: an agent step (name, prompt that reads fields, model, effort, permissions, Chat, what to do
//! when it fails, the Output table, what to do with invalid output), an If (field, test, value), an approval (message,
//! hours), a wait, a pull request (title, description, base, draft, ask first) and a Linear comment. Also the trigger's.
//!
//! One [`StepInspector`] per selected step (the page makes a new one when the selection changes, as React keys it by
//! step id). It owns the step's text states and emits the whole step on every edit; the page puts it in the draft and
//! sends the new context back (the fields the step can read, its problems).

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FontWeight, IntoElement, Render, SharedString, Subscription, Window, div, prelude::*,
    px,
};
use gpui_component::input::{InputEvent, InputState};

use super::look::{field_icon, step_look, trigger_title};
use super::ops::{self, Readable, fields_before, is_field_name, step_reads, trigger_fields, used_by};
use super::steps::{field_chip, step_menu};
use super::text::{FlowText, TextEvent};
use super::types::*;
use crate::data::Provider;
use crate::logic::copy::model_copy::PermissionMode;
use crate::routines::RoutinesView;
use crate::routines::list::card_shadow;
use crate::routines::model::model_choices;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Checkbox, FieldSize, Icon, IconButton, IconButtonSize, IconName, IconSize, Input, Select,
    SelectOption, SelectVariant,
};

/// What the inspector is told about the flow around its step.
#[derive(Clone)]
pub struct InspectorCtx {
    pub view: Entity<RoutinesView>,
    pub steps: Vec<FlowStep>,
    pub trigger: TriggerKind,
    /// "edited in this draft", "new in this draft", or nothing.
    pub status: Option<&'static str>,
    pub problems: Vec<String>,
    /// The issue a Test run would use, for the agent step's note.
    pub test_issue: Option<String>,
    pub can_up: bool,
    pub can_down: bool,
}

pub enum InspectorEvent {
    Change(FlowStep),
}

impl EventEmitter<InspectorEvent> for StepInspector {}

/// What kind of step the inspector shows, under its name (`KIND_WORDS`).
fn kind_words(kind: StepKind) -> &'static str {
    match kind {
        StepKind::Agent => "Agent step",
        StepKind::If => "Condition",
        StepKind::Ask => "Approval",
        StepKind::Wait => "Wait",
        StepKind::PullRequest | StepKind::LinearComment => "Action",
    }
}

/// An output field's two inputs: its name and, for a choice, its comma-separated choices.
struct FieldInputs {
    name: Entity<InputState>,
    choices: Entity<InputState>,
}

pub struct StepInspector {
    step: FlowStep,
    ctx: InspectorCtx,
    name: Entity<InputState>,
    /// The text states by key: `value`, `hours`, `minutes`, `state`, `timeout`, `base`.
    inputs: Vec<(&'static str, Entity<InputState>)>,
    /// The fields that read other fields: Prompt, Message, Title and Description, Comment.
    texts: Vec<(&'static str, Entity<FlowText>)>,
    rows: Vec<FieldInputs>,
    _subscriptions: Vec<Subscription>,
}

fn clamp_number(text: &str, min: u32, max: u32) -> u32 {
    text.trim().parse::<f64>().map_or(min, |n| n.round().clamp(f64::from(min), f64::from(max)) as u32)
}

impl StepInspector {
    pub fn new(step: FlowStep, ctx: InspectorCtx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = Vec::new();
        let field = |placeholder: &str, text: &str, window: &mut Window, cx: &mut Context<Self>| {
            let state = Input::state(placeholder.to_string(), window, cx);
            state.update(cx, |state, cx| state.set_value(text.to_string(), window, cx));
            state
        };
        let name = field("", &step.name, window, cx);
        let mut inputs: Vec<(&'static str, Entity<InputState>)> = Vec::new();
        let mut texts: Vec<(&'static str, Entity<FlowText>)> = Vec::new();
        let readable = fields_before(&ctx.steps, Some(&step.id), ctx.trigger);
        let mut text = |key: &'static str,
                        label: &'static str,
                        placeholder: &str,
                        rows: usize,
                        value: &str,
                        window: &mut Window,
                        cx: &mut Context<Self>| {
            let entity =
                cx.new(|cx| FlowText::new(&format!("{}-{key}", step.id), label, placeholder, rows, value, readable.clone(), window, cx));
            texts.push((key, entity));
        };
        match &step.body {
            StepBody::Agent(agent) => text("prompt", "Prompt", "What should the agent do?", 5, &agent.prompt, window, cx),
            StepBody::If(branching) => inputs.push(("value", field("", branching.value.as_deref().unwrap_or(""), window, cx))),
            StepBody::Ask(ask) => {
                text("message", "Message", "What should you check before the flow goes on?", 4, &ask.message, window, cx);
                inputs.push(("hours", field("", &ask.expires_in_hours.to_string(), window, cx)));
            }
            StepBody::Wait(wait) => {
                inputs.push((
                    "minutes",
                    field("", &if let Until::Time { minutes } = &wait.until { minutes.to_string() } else { "60".into() }, window, cx),
                ));
                inputs.push((
                    "state",
                    field(
                        "In Review",
                        &if let Until::LinearState { state } = &wait.until { state.clone() } else { String::new() },
                        window,
                        cx,
                    ),
                ));
                inputs.push(("timeout", field("", &wait.timeout_hours.to_string(), window, cx)));
            }
            StepBody::PullRequest(pr) => {
                text("title", "Title", "", 2, &pr.title, window, cx);
                text("body", "Description", "What the pull request does", 5, &pr.body, window, cx);
                inputs.push(("base", field("The repository's default", pr.base.as_deref().unwrap_or(""), window, cx)));
            }
            StepBody::LinearComment(comment) => text("body", "Comment", "What to post on the issue", 5, &comment.body, window, cx),
        }
        subscriptions.push(cx.subscribe(&name, |this, state, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let value = state.read(cx).value().to_string();
                this.edit(|step| step.name = value, cx);
            }
        }));
        for (key, state) in &inputs {
            let key = *key;
            subscriptions.push(cx.subscribe_in(state, window, move |this, state, event: &InputEvent, window, cx| match event {
                InputEvent::Change => this.read_input(key, cx),
                InputEvent::Blur => this.settle_number(key, state, window, cx),
                _ => {}
            }));
        }
        for (key, entity) in &texts {
            let key = *key;
            subscriptions.push(cx.subscribe(entity, move |this, entity, _: &TextEvent, cx| {
                let value = entity.read(cx).value(cx);
                this.edit(|step| set_text(step, key, value), cx);
            }));
        }
        let mut inspector = Self { step, ctx, name, inputs, texts, rows: Vec::new(), _subscriptions: subscriptions };
        if let StepBody::Agent(agent) = &inspector.step.body {
            let fields = agent.output.clone();
            for field in &fields {
                let row = inspector.field_inputs(field, window, cx);
                inspector.rows.push(row);
            }
        }
        inspector.sync_texts(cx);
        inspector
    }

    fn field_inputs(&mut self, field: &FlowField, window: &mut Window, cx: &mut Context<Self>) -> FieldInputs {
        let name = Input::state(String::new(), window, cx);
        name.update(cx, |state, cx| state.set_value(field.name.clone(), window, cx));
        let choices = Input::state("small, medium, large", window, cx);
        choices.update(cx, |state, cx| state.set_value(field.choices.join(", "), window, cx));
        let (name_sub, choices_sub) = (
            cx.subscribe(&name, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let (index, value) = (this.row_of(&state), state.read(cx).value().to_string());
                    if let Some(index) = index {
                        this.edit_field(index, |field| field.name = value, cx);
                    }
                }
            }),
            cx.subscribe(&choices, |this, state, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let (index, value) = (this.row_of(&state), state.read(cx).value().to_string());
                    if let Some(index) = index {
                        let parsed: Vec<String> = value.split(',').map(|choice| choice.trim_start().to_string()).collect();
                        this.edit_field(index, |field| field.choices = parsed, cx);
                    }
                }
            }),
        );
        self._subscriptions.push(name_sub);
        self._subscriptions.push(choices_sub);
        FieldInputs { name, choices }
    }

    fn row_of(&self, state: &Entity<InputState>) -> Option<usize> {
        self.rows.iter().position(|row| &row.name == state || &row.choices == state)
    }

    pub fn step(&self) -> &FlowStep {
        &self.step
    }

    /// Types a name, as the Name field would (tests).
    #[cfg(test)]
    pub fn type_name(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.name.update(cx, |state, cx| state.set_value(name.to_string(), window, cx));
        self.edit(|step| step.name = name.to_string(), cx);
    }

    /// The text field with this key (tests).
    #[cfg(test)]
    pub fn text_field(&self, key: &str) -> Option<Entity<FlowText>> {
        self.texts.iter().find(|(k, _)| *k == key).map(|(_, text)| text.clone())
    }

    /// The flow changed around the step: what it can read, its problems, its status.
    pub fn set_context(&mut self, ctx: InspectorCtx, cx: &mut Context<Self>) {
        self.ctx = ctx;
        self.sync_texts(cx);
        cx.notify();
    }

    fn sync_texts(&mut self, cx: &mut Context<Self>) {
        let fields = fields_before(&self.ctx.steps, Some(&self.step.id), self.ctx.trigger);
        let empty_invalid = |key: &str, step: &FlowStep| match (&step.body, key) {
            (StepBody::Agent(agent), "prompt") => agent.prompt.trim().is_empty(),
            (StepBody::PullRequest(pr), "title") => pr.title.trim().is_empty(),
            (StepBody::LinearComment(comment), "body") => comment.body.trim().is_empty(),
            _ => false,
        };
        for (key, entity) in &self.texts {
            let invalid = empty_invalid(key, &self.step);
            let fields = fields.clone();
            entity.update(cx, |text, cx| {
                text.set_fields(fields, cx);
                text.set_invalid(invalid, cx);
            });
        }
    }

    fn edit(&mut self, change: impl FnOnce(&mut FlowStep), cx: &mut Context<Self>) {
        change(&mut self.step);
        cx.emit(InspectorEvent::Change(self.step.clone()));
        cx.notify();
    }

    fn edit_field(&mut self, index: usize, change: impl FnOnce(&mut FlowField), cx: &mut Context<Self>) {
        self.edit(
            |step| {
                if let StepBody::Agent(agent) = &mut step.body
                    && let Some(field) = agent.output.get_mut(index)
                {
                    change(field);
                }
            },
            cx,
        );
    }

    fn input(&self, key: &str) -> Option<&Entity<InputState>> {
        self.inputs.iter().find(|(k, _)| *k == key).map(|(_, state)| state)
    }

    fn read_input(&mut self, key: &'static str, cx: &mut Context<Self>) {
        let Some(value) = self.input(key).map(|state| state.read(cx).value().to_string()) else { return };
        self.edit(
            |step| match (&mut step.body, key) {
                (StepBody::If(branching), "value") => branching.value = Some(value),
                (StepBody::Ask(ask), "hours") => ask.expires_in_hours = clamp_number(&value, 1, ops::MAX_ASK_HOURS),
                (StepBody::Wait(wait), "minutes") => wait.until = Until::Time { minutes: clamp_number(&value, 1, ops::MAX_WAIT_MINUTES) },
                (StepBody::Wait(wait), "state") => wait.until = Until::LinearState { state: value },
                (StepBody::Wait(wait), "timeout") => wait.timeout_hours = clamp_number(&value, 1, ops::MAX_TIMEOUT_HOURS),
                (StepBody::PullRequest(pr), "base") => pr.base = Some(value).filter(|base| !base.is_empty()),
                _ => {}
            },
            cx,
        );
    }

    /// A number field shows the clamped number once it loses focus (React rewrites it on every keystroke).
    fn settle_number(&mut self, key: &'static str, state: &Entity<InputState>, window: &mut Window, cx: &mut Context<Self>) {
        let shown = match (&self.step.body, key) {
            (StepBody::Ask(ask), "hours") => ask.expires_in_hours.to_string(),
            (StepBody::Wait(WaitStep { until: Until::Time { minutes }, .. }), "minutes") => minutes.to_string(),
            (StepBody::Wait(wait), "timeout") => wait.timeout_hours.to_string(),
            _ => return,
        };
        if state.read(cx).value().as_ref() != shown {
            state.update(cx, |state, cx| state.set_value(shown, window, cx));
        }
    }

    fn add_field(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let StepBody::Agent(agent) = &self.step.body else { return };
        let mut n = agent.output.len() + 1;
        while agent.output.iter().any(|field| field.name == format!("field{n}")) {
            n += 1;
        }
        let field = FlowField::new(format!("field{n}"), FieldType::Text);
        let row = self.field_inputs(&field, window, cx);
        self.rows.push(row);
        self.edit(
            |step| {
                if let StepBody::Agent(agent) = &mut step.body {
                    agent.output.push(field);
                }
            },
            cx,
        );
    }

    fn remove_field(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.rows.len() {
            self.rows.remove(index);
        }
        self.edit_field_list(
            |output| {
                if index < output.len() {
                    output.remove(index);
                }
            },
            cx,
        );
    }

    fn edit_field_list(&mut self, change: impl FnOnce(&mut Vec<FlowField>), cx: &mut Context<Self>) {
        self.edit(
            |step| {
                if let StepBody::Agent(agent) = &mut step.body {
                    change(&mut agent.output);
                }
            },
            cx,
        );
    }
}

fn set_text(step: &mut FlowStep, key: &str, value: String) {
    match (&mut step.body, key) {
        (StepBody::Agent(agent), "prompt") => agent.prompt = value,
        (StepBody::Ask(ask), "message") => ask.message = value,
        (StepBody::PullRequest(pr), "title") => pr.title = value,
        (StepBody::PullRequest(pr), "body") => pr.body = value,
        (StepBody::LinearComment(comment), "body") => comment.body = value,
        _ => {}
    }
}

// ----- the pieces -----

/// The inspector's card: the step's tile, name and what it is, a ⋯ beside it, then its settings.
pub(crate) fn inspector_card(
    selector: String,
    kind: Option<StepKind>,
    title: String,
    subtitle: String,
    menu: Option<AnyElement>,
    children: Vec<AnyElement>,
    theme: &Theme,
) -> AnyElement {
    let (icon, fill, ink) = step_look(kind, theme);
    div()
        .debug_selector(move || selector.clone())
        .rounded(RADIUS_CARD)
        .bg(theme.surface)
        .p(px(16.0))
        .shadow(card_shadow(theme))
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(12.0))
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(32.0))
                        .rounded(RADIUS_CONTROL)
                        .bg(fill)
                        .child(Icon::new(icon).size(IconSize::S16).color(ink)),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.0))
                        .child(div().truncate().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title))
                        .child(div().text_step(TEXT_12).text_color(theme.ink3).child(subtitle)),
                )
                .children(menu),
        )
        .child(div().mt(px(16.0)).flex().flex_col().gap(px(16.0)).children(children))
        .into_any_element()
}

/// A setting's row: its name on the left, its control on the right.
fn row(label: &str, control: impl IntoElement, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .min_h(px(36.0))
        .py(px(4.0))
        .border_b_1()
        .border_color(theme.line)
        .child(div().flex_none().text_step(TEXT_13).text_color(theme.ink2).child(label.to_string()))
        .child(div().flex().flex_1().min_w_0().justify_end().child(control))
        .into_any_element()
}

/// Rows share a bottom hairline except the last: the card draws them, so this strips the last one's.
fn rows(children: Vec<AnyElement>) -> AnyElement {
    div().flex().flex_col().children(children).into_any_element()
}

fn labeled(label: &str, trailing: Option<AnyElement>, child: impl IntoElement, theme: &Theme) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .min_h(px(24.0))
                .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(label.to_string()))
                .children(trailing),
        )
        .child(child)
        .into_any_element()
}

fn note(text: impl Into<SharedString>, theme: &Theme) -> AnyElement {
    div().text_step(TEXT_12).text_color(theme.ink3).child(text.into()).into_any_element()
}

fn number_input(id: &str, state: &Entity<InputState>) -> AnyElement {
    div().w(px(80.0)).child(Input::new(SharedString::from(id.to_string()), state).size(FieldSize::S32)).into_any_element()
}

fn text_input(id: &str, state: &Entity<InputState>, width: f32) -> AnyElement {
    div().w(px(width)).child(Input::new(SharedString::from(id.to_string()), state).size(FieldSize::S32)).into_any_element()
}

fn select(
    id: &str,
    value: &str,
    options: Vec<SelectOption>,
    width: f32,
    on_change: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
) -> AnyElement {
    Select::new(SharedString::from(id.to_string()), value.to_string(), options)
        .variant(SelectVariant::Text)
        .width(width)
        .on_change(on_change)
        .into_any_element()
}

fn retry_options() -> Vec<SelectOption> {
    (0..=ops::MAX_RETRIES)
        .map(|n| {
            let label = match n {
                0 => "Stop at once".to_string(),
                1 => "Retry once, then stop".to_string(),
                2 => "Retry twice, then stop".to_string(),
                n => format!("Retry {n} times, then stop"),
            };
            SelectOption::new(n.to_string(), label)
        })
        .collect()
}

impl StepInspector {
    fn name_field(&self, theme: &Theme) -> AnyElement {
        labeled("Name", None, div().child(Input::new("flow-step-name", &self.name).size(FieldSize::S32)), theme)
    }

    fn text(&self, key: &str) -> AnyElement {
        match self.texts.iter().find(|(k, _)| *k == key) {
            Some((_, entity)) => entity.clone().into_any_element(),
            None => div().into_any_element(),
        }
    }

    fn reads(&self, theme: &Theme) -> Option<AnyElement> {
        let refs = step_reads(&self.step);
        if refs.is_empty() {
            return None;
        }
        let readable: Vec<String> =
            fields_before(&self.ctx.steps, Some(&self.step.id), self.ctx.trigger).into_iter().map(|f| f.ref_).collect();
        let chips = refs.into_iter().map(|read| {
            let ok = readable.contains(&read);
            let (fill, ink) = if ok { (theme.purple_tint, theme.purple_ink) } else { (theme.red_tint, theme.red_ink) };
            let selector = format!("flow-read-{read}");
            div()
                .debug_selector(move || selector.clone())
                .flex()
                .items_center()
                .h(px(24.0))
                .px(px(8.0))
                .rounded(RADIUS_CHIP)
                .bg(fill)
                .text_step(TEXT_12)
                .text_color(ink)
                .child(read.trim_start_matches("trigger.").to_string())
        });
        Some(labeled("Reads", None, div().debug_selector(|| "flow-reads".into()).flex().flex_wrap().gap(px(6.0)).children(chips), theme))
    }

    fn agent_fields(&self, agent: &AgentStep, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        let this = cx.entity();
        let mut model_options = vec![SelectOption::new("", "The flow's model")];
        for choice in model_choices() {
            model_options
                .push(SelectOption::new(format!("{}:{}", choice.provider.id(), choice.id), choice.name).group(choice.provider.name()));
        }
        let model_value =
            agent.model.as_deref().map_or(String::new(), |model| format!("{}:{model}", agent.provider.map_or("", Provider::id)));
        let known = model_choices().into_iter().any(|choice| format!("{}:{}", choice.provider.id(), choice.id) == model_value);
        if agent.model.is_some() && !known {
            model_options.push(SelectOption::new(model_value.clone(), agent.model.clone().unwrap_or_default()));
        }
        let picked = agent.model.as_deref().and_then(|model| {
            model_choices().into_iter().find(|choice| choice.id == model && agent.provider.is_none_or(|p| p == choice.provider))
        });
        let efforts: Vec<&'static str> = picked.map(|choice| choice.efforts.to_vec()).unwrap_or_default();
        let mut effort_options = vec![SelectOption::new("", "Default effort")];
        effort_options.extend(
            efforts.iter().map(|effort| SelectOption::new(*effort, format!("{}{} effort", effort[..1].to_uppercase(), &effort[1..]))),
        );
        if let Some(effort) = agent.effort.as_deref().filter(|e| !efforts.contains(e)) {
            effort_options.push(SelectOption::new(effort, format!("{effort} effort")));
        }
        let mut mode_options = vec![SelectOption::new("", "The flow's mode")];
        mode_options.extend(PermissionMode::ALL.into_iter().map(|m| SelectOption::new(m.id(), m.name()).description(m.description())));

        let mut out = vec![self.name_field(&theme), self.text("prompt")];
        out.extend(self.reads(&theme));
        let mut settings = Vec::new();
        {
            let this = this.clone();
            let current = agent.effort.clone();
            settings.push(row(
                "Model",
                select("flow-model", &model_value, model_options, 280.0, move |value, _, cx| {
                    let value = value.to_string();
                    let current = current.clone();
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                let StepBody::Agent(agent) = &mut step.body else { return };
                                match value.split_once(':') {
                                    None => {
                                        agent.provider = None;
                                        agent.model = None;
                                        agent.effort = None;
                                    }
                                    Some((provider, model)) => {
                                        let next_efforts = model_choices()
                                            .into_iter()
                                            .find(|choice| choice.id == model && Some(choice.provider) == Provider::from_id(provider))
                                            .map(|choice| choice.efforts)
                                            .unwrap_or(&[]);
                                        agent.provider = Provider::from_id(provider);
                                        agent.model = Some(model.to_string());
                                        agent.effort = current.filter(|effort| next_efforts.contains(&effort.as_str()));
                                    }
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        if !efforts.is_empty() || agent.effort.is_some() {
            let this = this.clone();
            settings.push(row(
                "Effort",
                select("flow-effort", agent.effort.as_deref().unwrap_or(""), effort_options, 200.0, move |value, _, cx| {
                    let value = value.to_string();
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::Agent(agent) = &mut step.body {
                                    agent.effort = Some(value).filter(|effort| !effort.is_empty());
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        {
            let this = this.clone();
            settings.push(row(
                "Permissions",
                select("flow-permissions", agent.permission_mode.as_deref().unwrap_or(""), mode_options, 300.0, move |value, _, cx| {
                    let value = value.to_string();
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::Agent(agent) = &mut step.body {
                                    agent.permission_mode = Some(value).filter(|mode| !mode.is_empty());
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        {
            let this = this.clone();
            let options = vec![
                SelectOption::new("run", "Run Chat").description("The Chat the Run's first agent step made"),
                SelectOption::new("own", "Its own Chat").description("A new Chat in the same Worktree"),
            ];
            settings.push(row(
                "Chat",
                select("flow-chat", if agent.chat == ChatUse::Own { "own" } else { "run" }, options, 280.0, move |value, _, cx| {
                    let own = value.as_ref() == "own";
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::Agent(agent) = &mut step.body {
                                    agent.chat = if own { ChatUse::Own } else { ChatUse::Run };
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        {
            let this = this.clone();
            settings.push(row(
                "If it fails",
                select("flow-retries", &agent.retries.to_string(), retry_options(), 220.0, move |value, _, cx| {
                    let retries: u32 = value.parse().unwrap_or(1);
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::Agent(agent) = &mut step.body {
                                    agent.retries = retries;
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        out.push(rows(settings));
        out.push(self.output_fields(agent, cx));
        {
            let this = this.clone();
            let options = vec![SelectOption::new("ask-once", "Ask the agent once, then stop"), SelectOption::new("stop", "Stop")];
            let value = if agent.on_invalid == OnInvalid::Stop { "stop" } else { "ask-once" };
            out.push(row(
                "If output is invalid",
                select("flow-on-invalid", value, options, 260.0, move |value, _, cx| {
                    let stop = value.as_ref() == "stop";
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::Agent(agent) = &mut step.body {
                                    agent.on_invalid = if stop { OnInvalid::Stop } else { OnInvalid::AskOnce };
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        out
    }

    /// An agent step's Output table: each field's name, type (and choices), how many steps read it, and remove.
    fn output_fields(&self, agent: &AgentStep, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let this = cx.entity();
        let add = (agent.output.len() < ops::MAX_FIELDS).then(|| {
            let this = this.clone();
            Button::new("flow-add-field", "Add field")
                .variant(ButtonVariant::Quiet)
                .size(ButtonSize::S24)
                .icon(IconName::PlusSign)
                .on_click(move |_, window, cx| this.update(cx, |inspector, cx| inspector.add_field(window, cx)))
                .into_any_element()
        });
        let body: AnyElement = if agent.output.is_empty() {
            note("No fields. Add one for later steps to read what this agent decides.", &theme)
        } else {
            let last = agent.output.len() - 1;
            div()
                .debug_selector(|| "flow-output".into())
                .flex()
                .flex_col()
                .rounded(RADIUS_CONTROL)
                .border_1()
                .border_color(theme.line)
                .children(agent.output.iter().enumerate().map(|(index, field)| {
                    let ref_ = format!("{}.{}", self.step.id, field.name);
                    let readers = used_by(&self.ctx.steps, &ref_);
                    let bad_name = !is_field_name(&field.name);
                    let few_choices =
                        field.ty == FieldType::Choice && field.choices.iter().filter(|choice| !choice.trim().is_empty()).count() < 2;
                    let inputs = self.rows.get(index);
                    let selector = format!("flow-output-field-{}", field.name);
                    let (remove_this, type_this) = (this.clone(), this.clone());
                    let type_options: Vec<SelectOption> =
                        FieldType::ALL.into_iter().map(|ty| SelectOption::new(ty.id(), ty.words())).collect();
                    div()
                        .debug_selector(move || selector.clone())
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .px(px(8.0))
                        .py(px(8.0))
                        .when(index < last, |el| el.border_b_1().border_color(theme.line))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(Icon::new(field_icon(field.ty)).size(IconSize::S14).color(theme.ink3))
                                .child(div().flex_1().min_w_0().children(inputs.map(|inputs| {
                                    Input::new(SharedString::from(format!("flow-field-name-{index}")), &inputs.name)
                                        .size(FieldSize::S28)
                                        .invalid(bad_name)
                                })))
                                .child(select("flow-field-type", field.ty.id(), type_options, 160.0, move |value, window, cx| {
                                    let ty = FieldType::from_id(value);
                                    type_this.update(cx, |inspector, cx| {
                                        if ty == FieldType::Choice
                                            && let Some(row) = inspector.rows.get(index)
                                        {
                                            row.choices.update(cx, |state, cx| state.set_value(", ", window, cx));
                                        }
                                        inspector.edit_field(
                                            index,
                                            |field| {
                                                field.ty = ty;
                                                field.choices =
                                                    if ty == FieldType::Choice { vec![String::new(), String::new()] } else { Vec::new() };
                                            },
                                            cx,
                                        );
                                    });
                                }))
                                .child(
                                    div()
                                        .w(px(56.0))
                                        .flex_none()
                                        .text_right()
                                        .text_step(TEXT_11)
                                        .text_color(if readers > 0 { theme.accent_ink } else { theme.ink3 })
                                        .child(if readers > 0 { format!("used by {readers}") } else { "unused".to_string() }),
                                )
                                .child(
                                    IconButton::new(SharedString::from(format!("flow-field-remove-{index}")), IconName::Cancel01)
                                        .size(IconButtonSize::S24)
                                        .glyph(IconSize::S12)
                                        .on_click(move |_, _, cx| {
                                            remove_this.update(cx, |inspector, cx| inspector.remove_field(index, cx))
                                        }),
                                ),
                        )
                        .when_some(inputs.filter(|_| field.ty == FieldType::Choice), |el, inputs| {
                            el.child(
                                Input::new(SharedString::from(format!("flow-field-choices-{index}")), &inputs.choices)
                                    .size(FieldSize::S28)
                                    .invalid(few_choices),
                            )
                        })
                        .when(bad_name, |el| {
                            el.child(
                                div().text_step(TEXT_11).text_color(theme.red_ink).child("Letters, digits and _, starting with a letter"),
                            )
                        })
                        .when(!bad_name && few_choices, |el| {
                            el.child(
                                div().text_step(TEXT_11).text_color(theme.red_ink).child("Give at least two choices, separated by commas"),
                            )
                        })
                }))
                .into_any_element()
        };
        labeled("Output", add, body, &theme)
    }

    fn if_fields(&self, branching: &IfStep, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        let this = cx.entity();
        let fields: Vec<Readable> = fields_before(&self.ctx.steps, Some(&self.step.id), self.ctx.trigger);
        let mut field_options: Vec<SelectOption> =
            fields.iter().map(|field| SelectOption::new(field.ref_.clone(), field.label.clone()).group(field.step_name.clone())).collect();
        if !branching.field.is_empty() && !fields.iter().any(|field| field.ref_ == branching.field) {
            field_options.insert(0, SelectOption::new(branching.field.clone(), format!("{} (not readable here)", branching.field)));
        }
        if branching.field.is_empty() {
            field_options.insert(0, SelectOption::new("", "Choose a field").disabled(true));
        }
        let field = fields.iter().find(|entry| entry.ref_ == branching.field);
        let value = branching.value.clone().unwrap_or_default();
        // The values an option list offers, as (value, label).
        let mut value_pairs: Option<Vec<(String, String)>> = match field {
            Some(f) if f.ty == FieldType::Choice && !f.choices.is_empty() => {
                Some(f.choices.iter().map(|choice| (choice.clone(), choice.clone())).collect())
            }
            Some(f) if f.ty == FieldType::YesNo => Some(vec![("true".into(), "yes".into()), ("false".into(), "no".into())]),
            _ => None,
        };
        if let Some(pairs) = &mut value_pairs
            && !value.is_empty()
            && !pairs.iter().any(|(v, _)| v == &value)
        {
            pairs.insert(0, (value.clone(), value.clone()));
        }
        let value_choices: Option<Vec<SelectOption>> = value_pairs.map(|pairs| {
            let mut options: Vec<SelectOption> = pairs.into_iter().map(|(v, l)| SelectOption::new(v, l)).collect();
            if value.is_empty() {
                options.insert(0, SelectOption::new("", "Choose a value").disabled(true));
            }
            options
        });
        let mut settings = Vec::new();
        {
            let this = this.clone();
            let searchable = fields.len() > 8;
            let id = "flow-if-field";
            let picker = Select::new(id, branching.field.clone(), field_options).variant(SelectVariant::Text).width(280.0).on_change(
                move |value, window, cx| {
                    let value = value.to_string();
                    this.update(cx, |inspector, cx| {
                        if let Some(state) = inspector.input("value").cloned() {
                            state.update(cx, |state, cx| state.set_value(String::new(), window, cx));
                        }
                        inspector.edit(
                            |step| {
                                if let StepBody::If(branching) = &mut step.body {
                                    branching.field = value;
                                    branching.value = Some(String::new());
                                }
                            },
                            cx,
                        );
                    });
                },
            );
            settings.push(row("Field", if searchable { picker.searchable() } else { picker }, &theme));
        }
        {
            let this = this.clone();
            let options: Vec<SelectOption> = Test::ALL.into_iter().map(|test| SelectOption::new(test.id(), test.words())).collect();
            settings.push(row(
                "Test",
                select("flow-if-test", branching.test.id(), options, 160.0, move |value, _, cx| {
                    let test = Test::from_id(value);
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::If(branching) = &mut step.body {
                                    branching.test = test;
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        if branching.test != Test::IsSet {
            let control: AnyElement = match value_choices {
                Some(options) if branching.test != Test::Contains => {
                    let this = this.clone();
                    select("flow-if-value", &value, options, 200.0, move |value, window, cx| {
                        let value = value.to_string();
                        this.update(cx, |inspector, cx| {
                            if let Some(state) = inspector.input("value").cloned() {
                                state.update(cx, |state, cx| state.set_value(value.clone(), window, cx));
                            }
                            inspector.edit(
                                |step| {
                                    if let StepBody::If(branching) = &mut step.body {
                                        branching.value = Some(value);
                                    }
                                },
                                cx,
                            );
                        });
                    })
                }
                _ => match self.input("value") {
                    Some(state) => text_input("flow-if-value", state, 192.0),
                    None => div().into_any_element(),
                },
            };
            settings.push(row("Value", control, &theme));
        }
        vec![
            self.name_field(&theme),
            rows(settings),
            note(
                "Steps under Yes run when the test holds; steps under Otherwise run when it doesn't. Then the flow goes on after the If.",
                &theme,
            ),
        ]
    }

    fn ask_fields(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        let hours = self.input("hours").map(|state| row("Hours to answer", number_input("flow-ask-hours", state), &theme));
        let mut out = vec![self.name_field(&theme), self.text("message")];
        out.extend(hours);
        out.push(note("You can answer on any device. Rejecting it, or no answer in time, ends the Run.", &theme));
        out
    }

    fn wait_fields(&self, wait: &WaitStep, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        let this = cx.entity();
        let options = vec![
            SelectOption::new("time", "Some time passes"),
            SelectOption::new("linear-state", "The issue reaches a state"),
            SelectOption::new("pr-review", "The pull request is reviewed"),
        ];
        let mut settings = Vec::new();
        {
            let (this, minutes, state) = (this.clone(), self.input("minutes").cloned(), self.input("state").cloned());
            settings.push(row(
                "Until",
                select("flow-wait-until", wait.until.id(), options, 260.0, move |value, window, cx| {
                    let kind = value.to_string();
                    if let (Some(minutes), "time") = (&minutes, kind.as_str()) {
                        minutes.update(cx, |state, cx| state.set_value("60".to_string(), window, cx));
                    }
                    if let (Some(state), "linear-state") = (&state, kind.as_str()) {
                        state.update(cx, |state, cx| state.set_value(String::new(), window, cx));
                    }
                    this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::Wait(wait) = &mut step.body {
                                    wait.until = match kind.as_str() {
                                        "time" => Until::Time { minutes: 60 },
                                        "linear-state" => Until::LinearState { state: String::new() },
                                        _ => Until::PrReview,
                                    };
                                }
                            },
                            cx,
                        )
                    });
                }),
                &theme,
            ));
        }
        match &wait.until {
            Until::Time { .. } => {
                settings.extend(self.input("minutes").map(|state| row("Minutes", number_input("flow-wait-minutes", state), &theme)));
            }
            Until::LinearState { .. } => {
                settings.extend(self.input("state").map(|state| row("State", text_input("flow-wait-state", state, 192.0), &theme)));
            }
            Until::PrReview => {}
        }
        if !matches!(wait.until, Until::Time { .. }) {
            settings.extend(self.input("timeout").map(|state| row("Time limit, hours", number_input("flow-wait-timeout", state), &theme)));
        }
        let mut out = vec![self.name_field(&theme), rows(settings)];
        if !matches!(wait.until, Until::Time { .. }) {
            out.push(note("The step fails when the time limit passes first.", &theme));
        }
        out
    }

    fn pull_request_fields(&self, pr: &PullRequestStep, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        let this = cx.entity();
        let (draft_this, ask_this) = (this.clone(), this.clone());
        let mut out = vec![self.name_field(&theme), self.text("title"), self.text("body")];
        out.extend(self.input("base").map(|state| row("Base branch", text_input("flow-pr-base", state, 192.0), &theme)));
        out.push(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(Checkbox::new("flow-draft", pr.draft).label("Open as draft").on_toggle(move |on, _, cx| {
                    draft_this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::PullRequest(pr) = &mut step.body {
                                    pr.draft = on;
                                }
                            },
                            cx,
                        )
                    });
                }))
                .child(Checkbox::new("flow-ask-first", pr.ask_first).label("Ask me first").on_toggle(move |on, _, cx| {
                    ask_this.update(cx, |inspector, cx| {
                        inspector.edit(
                            |step| {
                                if let StepBody::PullRequest(pr) = &mut step.body {
                                    pr.ask_first = on;
                                }
                            },
                            cx,
                        )
                    });
                }))
                .into_any_element(),
        );
        out.push(note(
            "Pushes the Run's branch and opens the pull request once. It keeps a receipt, so a restart or a retry never opens a second one.",
            &theme,
        ));
        out
    }
}

impl Render for StepInspector {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let step = self.step.clone();
        let mut children: Vec<AnyElement> = Vec::new();
        if !self.ctx.problems.is_empty() {
            children.push(
                div()
                    .debug_selector(|| "flow-problems".into())
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.red_tint)
                    .px(px(12.0))
                    .py(px(8.0))
                    .children(self.ctx.problems.iter().map(|problem| {
                        div()
                            .flex()
                            .items_start()
                            .gap(px(8.0))
                            .text_step(TEXT_12)
                            .text_color(theme.red_ink)
                            .child(
                                div().mt(px(1.0)).flex_none().child(Icon::new(IconName::Alert02).size(IconSize::S14).color(theme.red_ink)),
                            )
                            .child(div().flex_1().min_w_0().child(problem.clone()))
                    }))
                    .into_any_element(),
            );
        }
        match &step.body {
            StepBody::Agent(agent) => children.extend(self.agent_fields(agent, cx)),
            StepBody::If(branching) => children.extend(self.if_fields(branching, cx)),
            StepBody::Ask(_) => children.extend(self.ask_fields(cx)),
            StepBody::Wait(wait) => children.extend(self.wait_fields(wait, cx)),
            StepBody::PullRequest(pr) => children.extend(self.pull_request_fields(pr, cx)),
            StepBody::LinearComment(_) => {
                children.push(self.name_field(&theme));
                children.push(self.text("body"));
                children.push(note("Posts to the Run's Linear issue once per Run.", &theme));
            }
        }
        if step.kind() == StepKind::Agent {
            let text = match &self.ctx.test_issue {
                Some(issue) => format!("Test run uses {issue}, the last issue this flow ran on."),
                None => "Test run uses sample or saved fields.".to_string(),
            };
            children.push(
                div()
                    .debug_selector(|| "flow-test-note".into())
                    .flex()
                    .items_start()
                    .gap(px(8.0))
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.page)
                    .px(px(12.0))
                    .py(px(8.0))
                    .text_step(TEXT_12)
                    .text_color(theme.ink2)
                    .child(div().mt(px(1.0)).flex_none().child(Icon::new(IconName::TestTube01).size(IconSize::S14).color(theme.ink3)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(format!("{text} It is a dry run: agents use sample or saved fields; actions and waits do not run.")),
                    )
                    .into_any_element(),
            );
        }
        let subtitle = match self.ctx.status {
            Some(status) => format!("{}, {status}", kind_words(step.kind())),
            None => kind_words(step.kind()).to_string(),
        };
        let title = if step.name.is_empty() { "Untitled step".to_string() } else { step.name.clone() };
        let menu = step_menu(&self.ctx.view, &step, self.ctx.can_up, self.ctx.can_down, true, None);
        inspector_card(format!("flow-inspector-{}", step.id), Some(step.kind()), title, subtitle, Some(menu), children, &theme)
    }
}

/// The trigger's inspector: what it gives the steps, and where to change it.
pub(crate) fn trigger_inspector(
    view: &Entity<RoutinesView>,
    trigger: &crate::routines::model::Trigger,
    text: &str,
    theme: &Theme,
) -> AnyElement {
    let gives = trigger_fields(super::look::trigger_kind(trigger));
    let example = gives.first().map_or("trigger.time".to_string(), |field| field.ref_.clone());
    let mut children: Vec<AnyElement> = Vec::new();
    if !gives.is_empty() {
        children.push(labeled(
            "Gives every step",
            None,
            div().flex().flex_wrap().gap(px(6.0)).children(gives.iter().map(|field| field_chip(&field.label, field_icon(field.ty), theme))),
            theme,
        ));
    }
    children.push(note(format!("A step reads one as {{{{trigger.<field>}}}}, for example {{{{{example}}}}}."), theme));
    let view = view.clone();
    children.push(
        div()
            .flex()
            .child(
                Button::new("flow-trigger-settings", "Change it in Settings")
                    .variant(ButtonVariant::Secondary)
                    .on_click(move |_, _, cx| view.update(cx, |this, cx| this.flow_open_settings(cx))),
            )
            .into_any_element(),
    );
    inspector_card(
        "flow-inspector-trigger".into(),
        None,
        trigger_title(trigger).to_string(),
        format!("Trigger, {text}"),
        None,
        children,
        theme,
    )
}

//! The onboarding screen (O-02; `Onboarding.tsx`): first launch, or no Project to open. Step 1 lists the agents on
//! this computer (ready, waiting for a sign-in, or not installed); step 2 opens, clones or starts a Project, or picks a
//! folder an agent worked in (a folder without Git says so and offers to set Git up first); the third step is the
//! app's first Chat, whose starters are in `starters.rs`.
//!
//! Every host call is the fixture's: installing, signing in, cloning and opening answer after a short wait so the busy
//! states are seen. Not built: the Dawn intro (O-03), the sky's radial glow, and the title bar's drag strip.

use std::time::Duration;

use gpui::{
    AnyElement, App, ClickEvent, ClipboardItem, Context, Entity, EventEmitter, FontWeight, IntoElement, KeyDownEvent, Render, ScrollHandle,
    Subscription, Task, Window, div, prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::fixture::{self, Scenario};
use super::model::{
    self, Account, AccountState, AgentFacts, AgentFolder, AgentRow, CODE_FOLDER, CliState, RowState, STEPS, Step, THIS_COMPUTER,
};
use super::sky;
use crate::data::Provider;
use crate::theme::{
    ActiveTheme, CONTROL_MD, RADIUS_CARD, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TEXT_26, TextStepExt, Theme,
    mono,
};
use crate::ui::{
    Button, ButtonVariant, FieldSize, Icon, IconButton, IconName, IconSize, InlineError, Input, ProviderLogo, ScrollArea, SectionLabel,
    Skeleton,
};

/// How long a fixture call takes.
const STEP_WAIT: Duration = Duration::from_millis(350);
const SIGN_IN_WAIT: Duration = Duration::from_millis(1500);
const INSTALL_WAIT: Duration = Duration::from_millis(900);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OnboardingEvent {
    /// A Project was opened (a folder, a clone, a new folder).
    Opened { name: String, path: String },
    /// "Skip, start a Chat without a project".
    Skip,
}

impl EventEmitter<OnboardingEvent> for Onboarding {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormKind {
    Clone,
    Create,
}

pub struct Onboarding {
    step: Step,
    facts: Option<Vec<AgentFacts>>,
    working: Option<Provider>,
    error: String,
    /// The self-installed agent whose command was just copied.
    copied: Option<Provider>,
    folders: Option<Vec<AgentFolder>>,
    expanded: Option<String>,
    form: Option<FormKind>,
    clone_input: Entity<InputState>,
    create_input: Entity<InputState>,
    busy: bool,
    /// A snapshot of the first Chat's starters instead of the steps.
    starters_preview: bool,
    scroll: ScrollHandle,
    tasks: Vec<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl Onboarding {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let clone_input = Input::state("https://github.com/owner/repository", window, cx);
        let create_input = Input::state("my-project", window, cx);
        let subscriptions = vec![
            cx.subscribe_in(&clone_input, window, |this, _, event: &InputEvent, _, cx| this.on_input(FormKind::Clone, event, cx)),
            cx.subscribe_in(&create_input, window, |this, _, event: &InputEvent, _, cx| this.on_input(FormKind::Create, event, cx)),
        ];
        let mut this = Self {
            step: Step::Agent,
            facts: None,
            working: None,
            error: String::new(),
            copied: None,
            folders: None,
            expanded: None,
            form: None,
            clone_input,
            create_input,
            busy: false,
            starters_preview: false,
            scroll: ScrollHandle::new(),
            tasks: Vec::new(),
            _subscriptions: subscriptions,
        };
        // The status and the history arrive a moment after the screen opens, as the host's answers do.
        this.later(STEP_WAIT, cx, |this, cx| {
            this.facts.get_or_insert_with(fixture::agents);
            cx.notify();
        });
        this.later(STEP_WAIT, cx, |this, cx| {
            this.folders.get_or_insert_with(fixture::folders);
            cx.notify();
        });
        this
    }

    /// A snapshot or test starts from this state, with every answer already in.
    pub fn apply(&mut self, scenario: Scenario, window: &mut Window, cx: &mut Context<Self>) {
        self.tasks.clear();
        self.facts = Some(fixture::agents());
        self.folders = Some(fixture::folders());
        match scenario {
            Scenario::Agent => {}
            Scenario::AgentChecking => self.facts = None,
            Scenario::AgentSigningIn => {
                self.set_account_state("codex", AccountState::SigningIn);
            }
            Scenario::Project | Scenario::ProjectEmpty | Scenario::ProjectLoading | Scenario::ProjectNoGit => {
                self.step = Step::Project;
                match scenario {
                    Scenario::ProjectEmpty => self.folders = Some(Vec::new()),
                    Scenario::ProjectLoading => self.folders = None,
                    Scenario::ProjectNoGit => self.expanded = Some("/Users/me/Documents/recipes".into()),
                    _ => {}
                }
            }
            Scenario::ProjectClone | Scenario::ProjectCreate => {
                self.step = Step::Project;
                let kind = if scenario == Scenario::ProjectClone { FormKind::Clone } else { FormKind::Create };
                self.open_form(kind, window, cx);
                let (state, text) = match kind {
                    FormKind::Clone => (self.clone_input.clone(), "https://github.com/the-ptf/milagre.git"),
                    FormKind::Create => (self.create_input.clone(), "weekend-app"),
                };
                state.update(cx, |input, cx| input.set_value(text, window, cx));
            }
            Scenario::FirstChat => self.starters_preview = true,
        }
        cx.notify();
    }

    fn later(&mut self, wait: Duration, cx: &mut Context<Self>, then: impl FnOnce(&mut Self, &mut Context<Self>) + 'static) {
        self.tasks.push(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| then(this, cx)).ok();
        }));
    }

    // ---- state the views and tests read ----

    pub fn step(&self) -> Step {
        self.step
    }

    pub fn rows(&self) -> Vec<AgentRow> {
        model::agent_rows(self.facts.as_deref())
    }

    pub fn folders(&self) -> Option<&[AgentFolder]> {
        self.folders.as_deref()
    }

    pub fn form(&self) -> Option<FormKind> {
        self.form
    }

    pub fn is_busy(&self) -> bool {
        self.busy
    }

    pub fn expanded(&self) -> Option<&str> {
        self.expanded.as_deref()
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    pub fn working(&self) -> Option<Provider> {
        self.working
    }

    pub fn input(&self, kind: FormKind) -> &Entity<InputState> {
        match kind {
            FormKind::Clone => &self.clone_input,
            FormKind::Create => &self.create_input,
        }
    }

    // ---- steps ----

    pub fn next(&mut self, cx: &mut Context<Self>) {
        self.step = Step::Project;
        cx.notify();
    }

    pub fn back(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            self.step = Step::Agent;
            cx.notify();
        }
    }

    pub fn skip(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            cx.emit(OnboardingEvent::Skip);
        }
    }

    /// The agent the Continue button names: the first one ready.
    pub fn ready_agent(&self) -> Option<Provider> {
        self.rows().into_iter().find(|row| row.state == RowState::Ready).map(|row| row.provider)
    }

    // ---- step 1 ----

    fn set_account_state(&mut self, id: &str, state: AccountState) {
        let Some(fact) = self.facts.as_mut().and_then(|facts| facts.iter_mut().find(|fact| fact.provider.id() == id)) else { return };
        let account = fact.account.get_or_insert_with(|| Account { id: "default".into(), state, plan: None, message: None });
        account.state = state;
        if state == AccountState::SignedIn {
            account.plan = Some("Pro".into());
            fact.cli = CliState::Ready;
        }
    }

    /// Install, Update, Sign in or Cancel on a row.
    pub fn act(&mut self, provider: Provider, cx: &mut Context<Self>) {
        let Some(row) = self.rows().into_iter().find(|row| row.provider == provider) else { return };
        if self.working.is_some() {
            return;
        }
        self.error.clear();
        match row.state {
            RowState::Missing | RowState::Outdated => {
                self.working = Some(provider);
                cx.notify();
                self.later(INSTALL_WAIT, cx, move |this, cx| {
                    this.working = None;
                    if let Some(fact) = this.facts.as_mut().and_then(|facts| facts.iter_mut().find(|fact| fact.provider == provider)) {
                        fact.cli = CliState::LoggedOut;
                        fact.account = Some(Account { id: "default".into(), state: AccountState::SignedOut, plan: None, message: None });
                    }
                    cx.notify();
                });
            }
            RowState::SignedOut => {
                self.set_account_state(provider.id(), AccountState::SigningIn);
                cx.notify();
                self.later(SIGN_IN_WAIT, cx, move |this, cx| {
                    // Cancelled meanwhile: nothing to finish.
                    if this.rows().iter().any(|row| row.provider == provider && row.state == RowState::SigningIn) {
                        this.set_account_state(provider.id(), AccountState::SignedIn);
                        cx.notify();
                    }
                });
            }
            RowState::SigningIn => {
                self.set_account_state(provider.id(), AccountState::SignedOut);
                cx.notify();
            }
            RowState::Ready | RowState::Checking => {}
        }
    }

    /// A self-installed agent's command, on the clipboard.
    pub fn copy_command(&mut self, provider: Provider, command: &str, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(command.to_string()));
        self.copied = Some(provider);
        cx.notify();
    }

    // ---- step 2 ----

    fn run_open(&mut self, name: String, path: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error.clear();
        cx.notify();
        self.later(STEP_WAIT, cx, move |this, cx| {
            this.busy = false;
            cx.emit(OnboardingEvent::Opened { name, path });
            cx.notify();
        });
    }

    /// `project:open`: the system's folder picker (the fixture picks one).
    pub fn open_folder(&mut self, cx: &mut Context<Self>) {
        self.run_open("picked".into(), "/Users/me/Code/picked".into(), cx);
    }

    /// `onboarding:open-at`: a folder with Git, or a plain one opened as it is.
    pub fn open_at(&mut self, path: &str, cx: &mut Context<Self>) {
        let name = self.folders().and_then(|folders| folders.iter().find(|folder| folder.path == path)).map(|f| f.name.clone());
        self.run_open(name.unwrap_or_default(), path.to_string(), cx);
    }

    /// `onboarding:set-up-git`: Git first, then the folder opens.
    pub fn set_up_git(&mut self, path: &str, cx: &mut Context<Self>) {
        self.open_at(path, cx);
    }

    pub fn open_form(&mut self, kind: FormKind, window: &mut Window, cx: &mut Context<Self>) {
        self.form = Some(kind);
        let input = self.input(kind).clone();
        let focus = gpui::Focusable::focus_handle(input.read(cx), cx);
        window.focus(&focus, cx);
        cx.notify();
    }

    pub fn close_form(&mut self, cx: &mut Context<Self>) {
        self.form = None;
        cx.notify();
    }

    fn form_value(&self, cx: &App) -> String {
        self.form.map(|kind| self.input(kind).read(cx).value().trim().to_string()).unwrap_or_default()
    }

    /// Clone or Create with what was typed.
    pub fn submit(&mut self, cx: &mut Context<Self>) {
        let (Some(kind), value) = (self.form, self.form_value(cx)) else { return };
        if value.is_empty() || self.busy {
            return;
        }
        match kind {
            FormKind::Clone => {
                let name = model::repository_name(&value);
                self.run_open(name.clone(), model::in_code(&name), cx);
            }
            FormKind::Create => self.run_open(value.clone(), model::in_code(&value), cx),
        }
    }

    pub fn toggle_folder(&mut self, path: &str, cx: &mut Context<Self>) {
        self.expanded = if self.expanded.as_deref() == Some(path) { None } else { Some(path.to_string()) };
        cx.notify();
    }

    fn on_input(&mut self, kind: FormKind, event: &InputEvent, cx: &mut Context<Self>) {
        match event {
            InputEvent::Change => cx.notify(),
            InputEvent::PressEnter { .. } if self.form == Some(kind) => self.submit(cx),
            _ => {}
        }
    }

    fn on_key(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" && self.form.is_some() {
            self.close_form(cx);
            cx.stop_propagation();
        }
    }
}

// ---- drawing ----

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A primary or quiet button with an arrow after (or before) its label, as `Button` with an `Icon` child is on the
/// desktop. `ui::Button` only takes a leading icon.
// A view builder: each argument is one thing the desktop's JSX passes as a prop.
#[allow(clippy::too_many_arguments)]
fn arrow_button(
    id: &'static str,
    label: String,
    icon: IconName,
    trailing: bool,
    primary: bool,
    disabled: bool,
    theme: &Theme,
    on_click: Click,
) -> AnyElement {
    let colour = if primary { theme.on_ink } else { theme.ink2 };
    let glyph = move || Icon::new(icon).size(IconSize::S16).color(colour);
    div()
        .id(id)
        .debug_selector(move || id.into())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .h(CONTROL_MD)
        .px(px(12.0))
        .rounded(RADIUS_CONTROL)
        .text_step(TEXT_13)
        .font_weight(FontWeight::MEDIUM)
        .text_color(colour)
        .when(primary, |el| el.bg(theme.ink))
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| {
            el.cursor_pointer()
                .when(primary, |el| el.hover(|el| el.opacity(0.9)))
                .when(!primary, |el| {
                    let (hover, ink) = (theme.hover, theme.ink);
                    el.hover(move |el| el.bg(hover).text_color(ink))
                })
                .on_click(move |event, window, cx| on_click(event, window, cx))
        })
        .when(!trailing, |el| el.child(glyph()))
        .child(label)
        .when(trailing, |el| el.child(glyph()))
        .into_any_element()
}

fn steps_header(step: Step, title: &str, lead: &str, theme: &Theme) -> AnyElement {
    let mut list = div().debug_selector(|| "onboarding-steps".into()).flex().items_center().gap(px(10.0)).text_step(TEXT_13);
    for (index, label) in STEPS.iter().enumerate() {
        let number = index + 1;
        let (fill, edge, text) = if number == step.number() {
            (theme.ink, theme.ink, theme.on_ink)
        } else if number < step.number() {
            (theme.surface, theme.ink, theme.ink)
        } else {
            (theme.surface, theme.line_strong, theme.ink3)
        };
        list = list.child(
            div()
                .flex()
                .items_center()
                .gap(px(10.0))
                .when(index > 0, |row| row.child(div().w(px(24.0)).h(px(1.0)).bg(theme.line_strong)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .font_weight(if number == step.number() { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM })
                        .text_color(if number == step.number() { theme.ink } else { theme.ink3 })
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(20.0))
                                .rounded_full()
                                .border_1()
                                .border_color(edge)
                                .bg(fill)
                                .text_color(text)
                                .text_step(TEXT_11)
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(number.to_string()),
                        )
                        .child(*label),
                ),
        );
    }
    div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(list)
        .child(div().mt(px(4.0)).text_step(TEXT_26).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title.to_string()))
        .child(div().text_step(TEXT_15).text_color(theme.ink2).child(lead.to_string()))
        .into_any_element()
}

impl Onboarding {
    fn agent_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let rows = self.rows();
        let mut list = div()
            .id("onboarding-agents")
            .debug_selector(|| "onboarding-agents".into())
            .overflow_hidden()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface);
        let count = rows.len();
        for (index, row) in rows.into_iter().enumerate() {
            let provider = row.provider;
            let muted = row.state == RowState::Missing;
            let own = model::self_installed(provider);
            let installing = self.working == Some(provider) && matches!(row.state, RowState::Missing | RowState::Outdated);
            let detail = if installing {
                if row.state == RowState::Outdated {
                    "Updating\u{2026}".to_string()
                } else {
                    "Installing\u{2026} this can take a minute".to_string()
                }
            } else {
                model::row_detail(&row, self.copied == Some(provider))
            };
            let this = cx.entity();
            let action: Option<AnyElement> = match (row.state, own) {
                (RowState::Ready, _) => Some(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .text_step(TEXT_13)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink)
                        .child(Icon::new(IconName::CheckmarkCircle02).size(IconSize::S16).color(theme.ink))
                        .child("Ready")
                        .into_any_element(),
                ),
                (RowState::Missing | RowState::Outdated, Some(own)) => {
                    let command = if row.state == RowState::Missing { own.install } else { Some(own.update) };
                    Some(match command {
                        Some(command) => Button::new(
                            format!("agent-copy-{}", provider.id()),
                            if self.copied == Some(provider) { "Copied" } else { "Copy command" },
                        )
                        .variant(ButtonVariant::Secondary)
                        .on_click(move |_, _, cx| this.update(cx, |this, cx| this.copy_command(provider, command, cx)))
                        .into_any_element(),
                        None => Button::new(format!("agent-get-{}", provider.id()), format!("Get {}", provider.name()))
                            .variant(ButtonVariant::Secondary)
                            .into_any_element(),
                    })
                }
                (RowState::Checking, _) => None,
                (state, _) => {
                    let label = match state {
                        RowState::Missing => {
                            if installing {
                                "Installing\u{2026}"
                            } else {
                                "Install"
                            }
                        }
                        RowState::Outdated => {
                            if installing {
                                "Updating\u{2026}"
                            } else {
                                "Update"
                            }
                        }
                        RowState::SigningIn => "Cancel",
                        _ => "Sign in",
                    };
                    Some(
                        div()
                            .min_w(px(84.0))
                            .child(
                                Button::new(format!("agent-act-{}", provider.id()), label)
                                    .variant(ButtonVariant::Secondary)
                                    .disabled(
                                        self.working.is_some()
                                            || (!matches!(state, RowState::Missing | RowState::Outdated) && row.account_id.is_none()),
                                    )
                                    .on_click(move |_, _, cx| this.update(cx, |this, cx| this.act(provider, cx))),
                            )
                            .into_any_element(),
                    )
                }
            };
            let selector = format!("agent-row-{}", provider.id());
            list = list.child(
                div()
                    .debug_selector(move || selector)
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .px(px(16.0))
                    .py(px(16.0))
                    .when(index + 1 < count, |el| el.border_b_1().border_color(theme.line))
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .items_center()
                            .justify_center()
                            .size(px(36.0))
                            .rounded(RADIUS_CONTROL)
                            .border_1()
                            .border_color(theme.line)
                            .bg(theme.inset)
                            .when(muted, |el| el.opacity(0.6))
                            .child(ProviderLogo::new(provider).size(20.0)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_step(TEXT_15)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(if muted { theme.ink2 } else { theme.ink })
                                    .child(provider.name()),
                            )
                            .child(
                                div().truncate().text_step(TEXT_13).text_color(if muted { theme.ink3 } else { theme.ink2 }).child(detail),
                            ),
                    )
                    .children(action),
            );
        }
        let (later, go) = (cx.entity(), cx.entity());
        let continue_label = match self.ready_agent() {
            Some(provider) => format!("Continue with {}", provider.name()),
            None => "Continue".to_string(),
        };
        div()
            .flex()
            .flex_col()
            .gap(px(28.0))
            .child(steps_header(
                Step::Agent,
                "Choose your agent",
                &format!("Milagre runs the coding agents you already use, with their own sign-in. We checked {THIS_COMPUTER} for them."),
                &theme,
            ))
            .child(list)
            .when(!self.error.is_empty(), |col| col.child(div().mt(px(-12.0)).child(InlineError::new(self.error.clone()))))
            .child(
                div()
                    .text_step(TEXT_13)
                    .text_color(theme.ink3)
                    .child("Add more accounts or pick an agent per Project later in Settings \u{203a} Accounts."),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div().ml(px(-12.0)).child(
                            Button::new("onboarding-later", "Set up later")
                                .variant(ButtonVariant::Quiet)
                                .on_click(move |_, _, cx| later.update(cx, |this, cx| this.next(cx))),
                        ),
                    )
                    .child(arrow_button(
                        "onboarding-continue",
                        continue_label,
                        IconName::ArrowRight02,
                        true,
                        true,
                        false,
                        &theme,
                        Box::new(move |_, _, cx| go.update(cx, |this, cx| this.next(cx))),
                    )),
            )
            .into_any_element()
    }
}

impl Onboarding {
    #[allow(clippy::too_many_arguments)]
    fn tile(
        &self,
        id: &'static str,
        icon: IconName,
        title: &str,
        detail: String,
        active: bool,
        cx: &mut Context<Self>,
        on_click: Click,
    ) -> AnyElement {
        let theme = *cx.theme();
        let busy = self.busy;
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex()
            .flex_col()
            .items_start()
            .h(px(108.0))
            .p(px(16.0))
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(if active { theme.line_strong } else { theme.line })
            .bg(if active { theme.hover2 } else { theme.surface })
            .when(busy, |el| el.opacity(0.4))
            .when(!busy, |el| {
                let (edge, fill) = (theme.line_strong, theme.hover);
                el.cursor_pointer()
                    .hover(move |el| el.border_color(edge).bg(fill))
                    .on_click(move |event, window, cx| on_click(event, window, cx))
            })
            .child(Icon::new(icon).size(IconSize::S18).color(theme.ink))
            .child(div().mt_auto().text_step(TEXT_15).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(title.to_string()))
            .child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink2).child(detail))
            .into_any_element()
    }

    fn form_card(&self, kind: FormKind, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let value = self.form_value(cx);
        let (close, submit) = (cx.entity(), cx.entity());
        let label = match (kind, self.busy) {
            (FormKind::Clone, true) => "Cloning\u{2026}",
            (FormKind::Clone, false) => "Clone",
            (FormKind::Create, true) => "Creating\u{2026}",
            (FormKind::Create, false) => "Create",
        };
        div()
            .id("onboarding-form")
            .debug_selector(|| "onboarding-form".into())
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| this.on_key(event, cx)))
            .mt(px(-8.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .p(px(8.0))
            .pl(px(12.0))
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(
                        if kind == FormKind::Clone { "onboarding-clone-input" } else { "onboarding-create-input" },
                        self.input(kind),
                    )
                    .bare()
                    .size(FieldSize::S32)
                    .disabled(self.busy),
                ),
            )
            .when(kind == FormKind::Create && !value.is_empty(), |row| {
                row.child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(model::in_code(&value)))
            })
            .child(
                Button::new("onboarding-submit", label)
                    .disabled(self.busy || value.is_empty())
                    .on_click(move |_, _, cx| submit.update(cx, |this, cx| this.submit(cx))),
            )
            .child(
                IconButton::new("onboarding-form-close", IconName::Cancel01)
                    .on_click(move |_, _, cx| close.update(cx, |this, cx| this.close_form(cx))),
            )
            .into_any_element()
    }

    fn folder_row(&self, folder: &AgentFolder, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let open = self.expanded.as_deref() == Some(folder.path.as_str());
        let busy = self.busy;
        let path = folder.path.clone();
        let (click, open_plain, git_first) = (cx.entity(), cx.entity(), cx.entity());
        let group: gpui::SharedString = format!("folder-{index}").into();
        let selector = format!("folder-{}", folder.name);
        let git = folder.git;
        let row = div()
            .id(gpui::ElementId::Name(format!("folder-row-{index}").into()))
            .debug_selector(move || selector)
            .group(group.clone())
            .flex()
            .items_center()
            .gap(px(12.0))
            .h(px(48.0))
            .px(px(10.0))
            .rounded(RADIUS_CONTROL)
            .when(busy, |el| el.opacity(0.4))
            .when(!busy, |el| {
                let hover = theme.hover;
                el.cursor_pointer().hover(move |el| el.bg(hover)).on_click({
                    let path = path.clone();
                    move |_, _, cx| click.update(cx, |this, cx| if git { this.open_at(&path, cx) } else { this.toggle_folder(&path, cx) })
                })
            })
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(32.0))
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.inset)
                    .child(Icon::new(if git { IconName::FolderGit } else { IconName::Folder01 }).size(IconSize::S16).color(theme.ink2)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .child(folder.name.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .font_family(mono())
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child(model::home_path(&folder.path)),
                    ),
            )
            .when(!git, |row| {
                row.child(
                    div()
                        .flex_none()
                        .px(px(8.0))
                        .py(px(2.0))
                        .rounded(RADIUS_CHIP)
                        .border_1()
                        .border_color(theme.line)
                        .bg(theme.inset)
                        .text_step(TEXT_11)
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink2)
                        .child("No Git"),
                )
            })
            .child(div().flex_none().text_step(TEXT_12).text_color(theme.ink3).child(format!(
                "{} \u{b7} {}",
                folder.provider.name(),
                model::last_used_label(folder.days_ago)
            )))
            .child(if git {
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .h(px(28.0))
                    .px(px(10.0))
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.ink)
                    .text_color(theme.on_ink)
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .invisible()
                    .group_hover(group, |el| el.visible())
                    .child("Open")
                    .into_any_element()
            } else if open {
                Icon::new(IconName::Cancel01).size(IconSize::S14).color(theme.ink2).into_any_element()
            } else {
                div().into_any_element()
            });
        let (plain_path, git_path) = (folder.path.clone(), folder.path.clone());
        let name = folder.name.clone();
        div()
            .rounded(RADIUS_CONTROL)
            .when(open, |el| el.bg(theme.hover))
            .child(row)
            .when(open && !git, |el| {
                el.child(
                    div()
                        .debug_selector(|| "onboarding-no-git".into())
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .pr(px(10.0))
                        .pb(px(10.0))
                        .pl(px(54.0))
                        .child(div().text_step(TEXT_13).text_color(theme.ink2).child(format!(
                            "{name} has no Git, so Chats work right in this folder instead of their own Worktree. Add Git later to run Chats side by side and undo their changes."
                        )))
                        .child(
                            div()
                                .flex()
                                .gap(px(8.0))
                                .child(
                                    Button::new("no-git-open", "Open folder")
                                        .disabled(busy)
                                        .on_click(move |_, _, cx| open_plain.update(cx, |this, cx| this.open_at(&plain_path, cx))),
                                )
                                .child(
                                    Button::new("no-git-setup", "Set up Git first")
                                        .variant(ButtonVariant::Secondary)
                                        .disabled(busy)
                                        .on_click(move |_, _, cx| git_first.update(cx, |this, cx| this.set_up_git(&git_path, cx))),
                                ),
                        ),
                )
            })
            .into_any_element()
    }

    fn project_step(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let (open, clone, create) = (cx.entity(), cx.entity(), cx.entity());
        let tiles = div()
            .grid()
            .grid_cols(3)
            .gap(px(12.0))
            .child(self.tile(
                "onboarding-tile-open",
                IconName::FolderOpen,
                "Open folder",
                format!("Pick one on {THIS_COMPUTER}"),
                false,
                cx,
                Box::new(move |_, _, cx| open.update(cx, |this, cx| this.open_folder(cx))),
            ))
            .child(self.tile(
                "onboarding-tile-clone",
                IconName::GitFork,
                "Clone a repository",
                "Paste a GitHub URL".into(),
                self.form == Some(FormKind::Clone),
                cx,
                Box::new(move |_, window, cx| clone.update(cx, |this, cx| this.open_form(FormKind::Clone, window, cx))),
            ))
            .child(self.tile(
                "onboarding-tile-create",
                IconName::FolderAdd,
                "Start from scratch",
                format!("New folder in {CODE_FOLDER}"),
                self.form == Some(FormKind::Create),
                cx,
                Box::new(move |_, window, cx| create.update(cx, |this, cx| this.open_form(FormKind::Create, window, cx))),
            ));
        let history = match &self.folders {
            Some(folders) if folders.is_empty() => None,
            loaded => {
                let sources = loaded.as_deref().map(model::sources).unwrap_or_default();
                let mut list = div()
                    .debug_selector(|| "onboarding-folders".into())
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .p(px(4.0))
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.surface);
                match loaded {
                    None => {
                        for _ in 0..3 {
                            list = list.child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(12.0))
                                    .h(px(48.0))
                                    .px(px(10.0))
                                    .child(Skeleton::new().secondary().size(px(32.0)))
                                    .child(Skeleton::new().w(px(160.0)).h(px(12.0))),
                            );
                        }
                    }
                    Some(folders) => {
                        for (index, folder) in folders.iter().enumerate() {
                            list = list.child(self.folder_row(folder, index, cx));
                        }
                    }
                }
                Some(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(SectionLabel::new("Where your agents worked recently"))
                                .when(!sources.is_empty(), |row| {
                                    row.child(
                                        div()
                                            .text_step(TEXT_12)
                                            .text_color(theme.ink3)
                                            .child(format!("From {} history", sources.join(" and "))),
                                    )
                                }),
                        )
                        .child(list),
                )
            }
        };
        let (back, skip) = (cx.entity(), cx.entity());
        let busy = self.busy;
        div()
            .flex()
            .flex_col()
            .gap(px(28.0))
            .child(steps_header(
                Step::Project,
                "Open a Project",
                "Any folder works. Folders with Git give each Chat its own Worktree.",
                &theme,
            ))
            .child(tiles)
            .when_some(self.form, |col, kind| col.child(self.form_card(kind, cx)))
            .when(!self.error.is_empty(), |col| col.child(div().mt(px(-8.0)).child(InlineError::new(self.error.clone()))))
            .children(history)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().ml(px(-12.0)).child(arrow_button(
                        "onboarding-back",
                        "Back".into(),
                        IconName::ArrowLeft02,
                        false,
                        false,
                        busy,
                        &theme,
                        Box::new(move |_, _, cx| back.update(cx, |this, cx| this.back(cx))),
                    )))
                    .child(arrow_button(
                        "onboarding-skip",
                        "Skip, start a Chat without a project".into(),
                        IconName::ArrowRight02,
                        true,
                        false,
                        busy,
                        &theme,
                        Box::new(move |_, _, cx| skip.update(cx, |this, cx| this.skip(cx))),
                    )),
            )
            .into_any_element()
    }
}

impl Render for Onboarding {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let content = if self.starters_preview {
            super::starters::FirstChatStarters::new(model::first_chat_starters("happiergym"), |_, _, _| {}).into_any_element()
        } else if self.step == Step::Agent {
            self.agent_step(cx)
        } else {
            self.project_step(cx)
        };
        let width = if self.step == Step::Agent { 520.0 } else { 600.0 };
        div()
            .id("onboarding")
            .debug_selector(|| "onboarding".into())
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.page)
            .text_color(theme.ink)
            .child(sky::sky(self.step, &theme))
            .child(
                div().relative().flex_1().min_h_0().child(
                    ScrollArea::new("onboarding-scroll", &self.scroll).child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .w_full()
                            .px(px(32.0))
                            .py(px(56.0))
                            .my_auto()
                            .child(div().w_full().max_w(px(width)).min_w_0().child(content)),
                    ),
                ),
            )
    }
}

//! The Accounts page (`AccountsSettings`, the limit switches and `ProjectAccountsSettings` in the desktop):
//! provider cards with their accounts (select the default, sign in again, remove, add), the Antigravity install
//! row, "Usage limits" and "Per Project". Actions go to the global [`AccountsStore`]; a sign-in the store starts
//! finishes a moment later, as the browser round trip would.

use std::time::Duration;

use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Subscription, Window, div,
    prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::model::{AccountEntry, AccountState, AccountsStore, Action, CliPhase, CliState, ProjectProvider, ProviderGroup, Scope};
use crate::data::Provider;
use crate::settings::group::{CheckboxRow, SettingsGroup, page_header};
use crate::settings::store::SettingsStore;
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, InlineError, Input, ProgressBar, ProviderLogo, Select, SelectOption,
    Tooltip,
};

/// How long the fixture's browser sign-in takes.
const SIGN_IN_MS: u64 = 1500;
/// How long a refresh of the account list takes.
const REFRESH_MS: u64 = 400;
/// One step of the Antigravity download, in milliseconds.
const INSTALL_STEP_MS: u64 = 250;
const INSTALL_BYTES: f64 = 120.0 * 1024.0 * 1024.0;

/// The page entity: the add-account form, what is in flight and the Per Project choice.
pub struct AccountsView {
    adding: Option<Provider>,
    name: Option<Entity<InputState>>,
    _name_sub: Option<Subscription>,
    busy: bool,
    error: String,
    scope: Option<String>,
    found: Option<String>,
}

impl AccountsView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        cx.observe_global::<AccountsStore>(|_, cx| cx.notify()).detach();
        cx.observe_global::<SettingsStore>(|_, cx| cx.notify()).detach();
        Self { adding: None, name: None, _name_sub: None, busy: false, error: String::new(), scope: None, found: None }
    }

    /// The row a Settings search result lit up.
    pub fn set_found(&mut self, row: Option<&str>, cx: &mut Context<Self>) {
        if self.found.as_deref() != row {
            self.found = row.map(str::to_string);
            cx.notify();
        }
    }

    pub fn adding(&self) -> Option<Provider> {
        self.adding
    }

    pub fn busy(&self) -> bool {
        self.busy
    }

    pub fn scope(&self, cx: &App) -> String {
        self.scope
            .clone()
            .or_else(|| cx.global::<AccountsStore>().sorted_scopes().first().map(|scope| scope.key.clone()))
            .unwrap_or_default()
    }

    pub fn name_input(&self) -> Option<Entity<InputState>> {
        self.name.clone()
    }

    fn ensure_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<InputState> {
        if let Some(input) = &self.name {
            return input.clone();
        }
        let input = Input::state("Personal or work", window, cx);
        self._name_sub = Some(cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { .. } => this.submit(window, cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        }));
        self.name = Some(input.clone());
        input
    }

    fn update_store(cx: &mut App, f: impl FnOnce(&mut AccountsStore)) {
        cx.update_global::<AccountsStore, _>(|store, _| f(store));
    }

    /// The Refresh button: reads the list again.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(REFRESH_MS)).await;
            this.update(cx, |this, cx| {
                this.busy = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// "Add account": opens the name form under the provider's accounts.
    pub fn begin_add(&mut self, provider: Provider, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.ensure_input(window, cx);
        input.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        self.adding = Some(provider);
        cx.notify();
    }

    pub fn cancel_add(&mut self, cx: &mut Context<Self>) {
        self.adding = None;
        cx.notify();
    }

    /// "Continue to sign in": adds the named account, which signs in in the browser.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(provider), Some(input)) = (self.adding, self.name.clone()) else { return };
        let label = input.read(cx).value().to_string();
        if self.busy || label.trim().is_empty() {
            return;
        }
        let mut added = None;
        Self::update_store(cx, |store| added = store.add(provider, &label));
        self.error = if added.is_some() { String::new() } else { "Could not update this account. Try again.".to_string() };
        self.adding = None;
        input.update(cx, |state, cx| state.set_value("", window, cx));
        if let Some(id) = added {
            self.finish_sign_in_later(provider, id, cx);
        }
        cx.notify();
    }

    /// Sign in again, cancel it, select, or remove.
    pub fn act(&mut self, action: Action, provider: Provider, id: &str, cx: &mut Context<Self>) {
        self.error.clear();
        Self::update_store(cx, |store| store.act(action, provider, id));
        if action == Action::Login {
            self.finish_sign_in_later(provider, id.to_string(), cx);
        }
        cx.notify();
    }

    fn finish_sign_in_later(&mut self, provider: Provider, id: String, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(SIGN_IN_MS)).await;
            this.update(cx, |_, cx| {
                Self::update_store(cx, |store| store.finish_sign_in(provider, &id));
            })
            .ok();
        })
        .detach();
    }

    /// The Antigravity row's button: downloads, unpacks and checks the CLI, step by step.
    pub fn install_antigravity(&mut self, cx: &mut Context<Self>) {
        if cx.global::<AccountsStore>().cli.working {
            return;
        }
        Self::update_store(cx, |store| {
            store.cli.working = true;
            store.cli.error.clear();
            store.cli.phase = Some(CliPhase::Starting);
        });
        cx.spawn(async move |this, cx| {
            let mut phases: Vec<CliPhase> =
                (1..=5).map(|step| CliPhase::Download { received: INSTALL_BYTES * f64::from(step) / 5.0, total: INSTALL_BYTES }).collect();
            phases.extend([CliPhase::Extract, CliPhase::Validate]);
            for phase in phases {
                cx.background_executor().timer(Duration::from_millis(INSTALL_STEP_MS)).await;
                if this.update(cx, |_, cx| Self::update_store(cx, |store| store.cli.phase = Some(phase))).is_err() {
                    return;
                }
            }
            this.update(cx, |_, cx| {
                Self::update_store(cx, |store| {
                    store.cli.working = false;
                    store.cli.phase = None;
                    store.cli.state = Some(CliState::Ok);
                    if let Some(group) = store.groups.iter_mut().find(|group| group.provider == Provider::Antigravity) {
                        group.installed = true;
                        if group.accounts.is_empty() {
                            group.accounts.push(AccountEntry {
                                account: super::model::ProviderAccount {
                                    id: super::model::DEFAULT_ACCOUNT.to_string(),
                                    label: "Personal".to_string(),
                                    state: AccountState::Ready,
                                    email: Some("victor@example.com".to_string()),
                                    plan: Some("pro".to_string()),
                                    limited_until: None,
                                    missing: false,
                                },
                                message: None,
                            });
                        }
                    }
                });
            })
            .ok();
        })
        .detach();
    }

    /// Per Project: the scope whose accounts the rows show.
    pub fn set_scope(&mut self, key: &str, cx: &mut Context<Self>) {
        self.scope = Some(key.to_string());
        cx.notify();
    }

    /// Per Project: assigns (or, with an empty id, clears) a provider's account for the picked scope.
    pub fn assign(&mut self, provider: Provider, account_id: &str, cx: &mut Context<Self>) {
        let scope = self.scope(cx);
        Self::update_store(cx, |store| store.assign(&scope, provider, Some(account_id)));
        cx.notify();
    }

    fn hit(&self, title: &str) -> bool {
        self.found.as_deref() == Some(title)
    }
}

/// A row that a search result lit up.
fn lit(theme: &Theme, on: bool) -> impl FnOnce(gpui::Div) -> gpui::Div + use<> {
    let fill = theme.hover2;
    move |el| if on { el.bg(fill).debug_selector(|| "settings-found-row".into()) } else { el }
}

fn account_type_mark(entry: &AccountEntry, theme: &Theme, key: &str) -> Option<AnyElement> {
    let kind = super::model::account_type(entry.account.plan.as_deref())?;
    let icon = match kind {
        "Business" => IconName::Briefcase01,
        "Team" => IconName::UserMultiple,
        _ => IconName::User,
    };
    Some(
        div()
            .id(SharedString::from(format!("account-type-{key}")))
            .flex()
            .flex_none()
            .text_color(theme.ink3)
            .tooltip(Tooltip::text(format!("{kind} account")))
            .child(Icon::new(icon).size(IconSize::S14).color(theme.ink3))
            .into_any_element(),
    )
}

impl Render for AccountsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let input = self.ensure_input(window, cx);
        let theme = *cx.theme();
        let store = cx.global::<AccountsStore>().clone();
        let signing_in = store.signing_in();
        let first_adder = store.groups.iter().find(|group| group.can_add()).map(|group| group.provider);

        let intro = div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(24.0))
            .child(
                div()
                    .max_w(px(430.0))
                    .text_step(TEXT_13)
                    .line_height(px(20.0))
                    .text_color(theme.ink3)
                    .child("Choose the computer default for each provider. Projects and Links can choose a different account under Per Project, below."),
            )
            .child(
                Button::new("accounts-refresh", "Refresh")
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::S28)
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
            );

        let cards: Vec<AnyElement> = store
            .groups
            .iter()
            .map(|group| self.provider_card(group, signing_in, first_adder == Some(group.provider), &input, &theme, cx))
            .collect();

        div()
            .debug_selector(|| "settings-section-accounts".into())
            .flex()
            .flex_col()
            .child(page_header("Accounts", None, cx))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(20.0))
                    .child(intro)
                    .child(InlineError::new(self.error.clone()))
                    .children(cards)
                    .child(
                        div()
                            .text_step(TEXT_12)
                            .line_height(px(20.0))
                            .text_color(theme.ink3)
                            .child("Add and sign in on this computer. Paired phones can switch accounts. Remove keeps the local profile; removing the active account selects the connected CLI account."),
                    ),
            )
            .child(div().mt(px(24.0)).child(self.limits_group(cx)))
            .child(self.per_project(&store, &theme, cx))
    }
}

impl AccountsView {
    fn provider_card(
        &self,
        group: &ProviderGroup,
        signing_in: bool,
        first_adder: bool,
        input: &Entity<InputState>,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let provider = group.provider;
        let key = provider.id();
        let add_matched = first_adder && self.hit("Add account");
        let add_button = group.can_add().then(|| {
            div().rounded(RADIUS_CONTROL).when(add_matched, |el| el.bg(theme.hover2).debug_selector(|| "settings-found-row".into())).child(
                Button::new(SharedString::from(format!("accounts-add-{key}")), "Add account")
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::S28)
                    .disabled(self.busy || signing_in)
                    .on_click(cx.listener(move |this, _, window, cx| this.begin_add(provider, window, cx))),
            )
        });
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(theme.line)
            .px(px(16.0))
            .py(px(16.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_step(TEXT_15)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.ink)
                    .child(ProviderLogo::new(provider).size(20.0))
                    .child(provider.name()),
            )
            .children(add_button);

        let mut card = div()
            .debug_selector(move || format!("accounts-card-{key}"))
            .overflow_hidden()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .when(!group.installed, |el| el.pb(px(12.0)))
            .child(header);
        if provider == Provider::Antigravity {
            card = card.child(self.antigravity_row(theme, cx));
        }
        if group.installed {
            card =
                card.child(div().flex().flex_col().gap(px(8.0)).p(px(12.0)).children(
                    group.accounts.iter().map(|entry| self.account_row(group, entry, signing_in, theme, cx)).collect::<Vec<_>>(),
                ));
            if self.adding == Some(provider) {
                card = card.child(self.add_form(input, theme, cx));
            }
        }
        card.into_any_element()
    }

    fn antigravity_row(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let cli = cx.global::<AccountsStore>().cli.clone();
        let detail = cli.detail();
        div()
            .debug_selector(|| "accounts-antigravity-row".into())
            .mx(px(12.0))
            .mt(px(12.0))
            .flex()
            .flex_col()
            .gap(px(8.0))
            .rounded(RADIUS_CONTROL)
            .border_1()
            .border_color(theme.line)
            .p(px(12.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Antigravity"))
                            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(detail)),
                    )
                    .when(cli.shows_button(), |el| {
                        el.child(
                            Button::new("accounts-antigravity-install", cli.label())
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S28)
                                .disabled(cli.working)
                                .on_click(cx.listener(|this, _, _, cx| this.install_antigravity(cx))),
                        )
                    }),
            )
            .when(cli.working, |el| el.child(ProgressBar::new(cli.percent())))
            .child(InlineError::new(cli.error.clone()).small())
            .into_any_element()
    }

    fn account_row(
        &self,
        group: &ProviderGroup,
        entry: &AccountEntry,
        signing_in: bool,
        theme: &Theme,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let provider = group.provider;
        let id = entry.id().to_string();
        let selected = group.selected_id == id;
        let key = format!("{}-{}", provider.id(), id);
        let ready = entry.account.state == AccountState::Ready;
        let detail = entry.detail();
        let busy = self.busy;
        let radio = {
            let id = id.clone();
            div()
                .id(SharedString::from(format!("account-select-{key}")))
                .debug_selector({
                    let key = key.clone();
                    move || format!("account-select-{key}")
                })
                .flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(12.0))
                .px(px(12.0))
                .py(px(12.0))
                .rounded(RADIUS_CONTROL)
                .when(!busy && ready, |el| {
                    el.cursor_pointer().on_click(cx.listener(move |this, _, _, cx| {
                        if !selected {
                            this.act(Action::Select, provider, &id, cx);
                        }
                    }))
                })
                .child(
                    Icon::new(if selected { IconName::CheckmarkCircle02 } else { IconName::Circle })
                        .size(IconSize::S18)
                        .color(if selected { theme.ink } else { theme.ink3 }),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_step(TEXT_13)
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.ink)
                                        .child(entry.title().to_string()),
                                )
                                .children(account_type_mark(entry, theme, &key))
                                .when(selected, |el| {
                                    el.child(div().flex_none().text_step(TEXT_11).text_color(theme.ink2).child("Default"))
                                }),
                        )
                        .when(!detail.is_empty(), |el| el.child(div().text_step(TEXT_12).text_color(theme.ink3).child(detail)))
                        .when_some(entry.message.clone(), |el, message| {
                            el.child(div().max_w(px(390.0)).text_step(TEXT_12).line_height(px(20.0)).text_color(theme.ink3).child(message))
                        }),
                )
        };

        let signing = entry.account.state == AccountState::SigningIn;
        let actions = group.can_reauthenticate(&id).then(|| {
            let (login_id, cancel_id, remove_id) = (id.clone(), id.clone(), id.clone());
            div()
                .flex()
                .flex_none()
                .gap(px(8.0))
                .child(if signing {
                    Button::new(SharedString::from(format!("account-cancel-{key}")), "Cancel")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| this.act(Action::Cancel, provider, &cancel_id, cx)))
                        .into_any_element()
                } else {
                    div()
                        .id(SharedString::from(format!("account-login-tip-{key}")))
                        .tooltip(Tooltip::text("Sign in again in this computer's browser"))
                        .child(
                            Button::new(SharedString::from(format!("account-login-{key}")), "Re-authenticate")
                                .variant(ButtonVariant::Ghost)
                                .size(ButtonSize::S28)
                                .icon(IconName::Refresh)
                                .disabled(busy || signing_in)
                                .on_click(cx.listener(move |this, _, _, cx| this.act(Action::Login, provider, &login_id, cx))),
                        )
                        .into_any_element()
                })
                .when(id != super::model::DEFAULT_ACCOUNT, |el| {
                    el.child(
                        div()
                            .id(SharedString::from(format!("account-remove-tip-{key}")))
                            .tooltip(Tooltip::text(
                                "Remove from Milagre. The local profile remains. Removing the active account selects the connected CLI account.",
                            ))
                            .child(
                                Button::new(SharedString::from(format!("account-remove-{key}")), "Remove")
                                    .variant(ButtonVariant::DangerGhost)
                                    .size(ButtonSize::S28)
                                    .icon(IconName::Delete02)
                                    .disabled(busy)
                                    .on_click(cx.listener(move |this, _, _, cx| this.act(Action::Remove, provider, &remove_id, cx))),
                            ),
                    )
                })
        });

        let hover = theme.hover;
        div()
            .id(SharedString::from(format!("account-row-{key}")))
            .debug_selector(move || format!("account-row-{key}"))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(RADIUS_CONTROL)
            .border_1()
            .border_color(if selected { theme.line_strong } else { theme.line })
            .pr(px(12.0))
            .hover(move |style| style.bg(hover))
            .child(radio)
            .children(actions)
            .into_any_element()
    }

    fn add_form(&self, input: &Entity<InputState>, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let empty = input.read(cx).value().trim().is_empty();
        div()
            .debug_selector(|| "accounts-add-form".into())
            .flex()
            .flex_col()
            .gap(px(12.0))
            .border_t_1()
            .border_color(theme.line)
            .px(px(16.0))
            .py(px(16.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Account name"))
                    .child(Input::new("accounts-name", input)),
            )
            .child(
                div()
                    .text_step(TEXT_12)
                    .text_color(theme.ink3)
                    .child("Sign-in opens in your computer's browser. Choose the account you want to add."),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        Button::new("accounts-add-continue", "Continue to sign in")
                            .size(ButtonSize::S28)
                            .disabled(self.busy || empty)
                            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
                    )
                    .child(
                        Button::new("accounts-add-cancel", "Cancel")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, _, cx| this.cancel_add(cx))),
                    ),
            )
            .into_any_element()
    }

    /// "Usage limits": the two switches `LimitAutoSwitchSetting` saves.
    fn limits_group(&self, cx: &mut Context<Self>) -> AnyElement {
        let (auto, resume) = {
            let store = cx.global::<SettingsStore>();
            (store.limit_auto_switch, store.limit_resume_at_reset)
        };
        let found = self.found.as_deref();
        SettingsGroup::new()
            .title("Usage limits")
            .highlighted_row(found.map(|row| SharedString::from(row.to_string())))
            .row(
                CheckboxRow::new("accounts-auto-switch", "Switch accounts at usage limits", auto)
                    .description("When a Chat hits its plan's usage limit, move its Project to the next signed-in account and continue.")
                    .highlighted(found)
                    .on_change(|next, _, cx| cx.update_global::<SettingsStore, _>(|store, _| store.limit_auto_switch = next)),
            )
            .row(
                CheckboxRow::new("accounts-resume-at-reset", "Continue when the limit resets", resume)
                    .description(
                        "When a Chat hits its plan's usage limit and no other account can take over, continue it at the reset time, up to a day later.",
                    )
                    .highlighted(found)
                    .on_change(|next, _, cx| cx.update_global::<SettingsStore, _>(|store, _| store.limit_resume_at_reset = next)),
            )
            .into_any_element()
    }

    /// "Per Project": which saved accounts a Project or Link uses.
    fn per_project(&self, store: &AccountsStore, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let scopes = store.sorted_scopes();
        let scope_key = self.scope(cx);
        let selected: Option<&Scope> = scopes.iter().copied().find(|scope| scope.key == scope_key);
        let heading_matched = self.hit("Per Project");
        let picker_matched = self.hit("Project or Link");

        let options: Vec<SelectOption> = scopes
            .iter()
            .map(|scope| SelectOption::new(scope.key.clone(), scope.name.clone()).group(if scope.link { "Links" } else { "Projects" }))
            .collect();
        let picker = Select::new("accounts-project-picker", scope_key.clone(), options)
            .width(300.0)
            .disabled(scopes.is_empty())
            .on_change(cx.listener(|this, value: &SharedString, _, cx| this.set_scope(value, cx)));

        let head = div()
            .flex()
            .min_h(px(56.0))
            .items_center()
            .justify_between()
            .gap(px(16.0))
            .px(px(16.0))
            .py(px(12.0))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .self_start()
                            .rounded(RADIUS_CONTROL)
                            .map(lit(theme, picker_matched))
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .child("Project or Link"),
                    )
                    .when(selected.is_some_and(|scope| scope.link), |el| {
                        el.child(
                            div()
                                .text_step(TEXT_12)
                                .text_color(theme.ink3)
                                .child("This Link's accounts are independent of its member Projects."),
                        )
                    })
                    .when(selected.is_some_and(|scope| scope.chats_home), |el| {
                        el.child(div().text_step(TEXT_12).text_color(theme.ink3).child(format!("{}.", super::model::CHATS_ACCOUNT_DETAIL)))
                    }),
            )
            .child(picker);

        let rows: Vec<AnyElement> = if scopes.is_empty() {
            vec![
                div()
                    .px(px(16.0))
                    .py(px(12.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink3)
                    .child("Open a Project to choose its accounts.")
                    .into_any_element(),
            ]
        } else {
            store.project_accounts(&scope_key).iter().map(|view| self.project_row(view, &scope_key, theme, cx)).collect()
        };

        let mut card = div()
            .debug_selector(|| "accounts-per-project".into())
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(RADIUS_CARD)
            .border_1()
            .border_color(theme.line)
            .bg(theme.surface)
            .child(head);
        for row in rows {
            card = card.child(div().w_full().h(px(1.0)).bg(theme.line)).child(row);
        }

        div()
            .mt(px(24.0))
            .flex()
            .flex_col()
            .child(
                div()
                    .self_start()
                    .mb(px(8.0))
                    .px(px(4.0))
                    .rounded(RADIUS_CONTROL)
                    .map(lit(theme, heading_matched))
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink3)
                    .child("Per Project"),
            )
            .child(
                div().flex().flex_col().child(
                    div()
                        .mt(px(12.0))
                        .child(
                            div()
                                .text_step(TEXT_13)
                                .text_color(theme.ink3)
                                .child("Choose which saved accounts a Project or Link uses on this computer."),
                        )
                        .child(div().mt(px(24.0)).child(card))
                        .child(
                            div()
                                .mt(px(8.0))
                                .px(px(4.0))
                                .text_step(TEXT_12)
                                .text_color(theme.ink3)
                                .child("Running replies keep their original account. The next turn uses the one chosen here."),
                        ),
                ),
            )
            .into_any_element()
    }

    fn project_row(&self, view: &ProjectProvider, scope: &str, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let provider = view.provider;
        let key = provider.id();
        let name = provider.name();
        let missing = view.missing();
        let needs_sign_in = view.needs_sign_in();
        let effective = view.effective();
        let choices: Vec<SelectOption> = view
            .choices()
            .into_iter()
            .map(|choice| {
                let mut option = SelectOption::new(choice.value, choice.label).disabled(choice.disabled);
                if let Some(description) = choice.description {
                    option = option.description(description);
                }
                option
            })
            .collect();
        let select =
            Select::new(SharedString::from(format!("accounts-project-{key}")), view.account_id.clone().unwrap_or_default(), choices)
                .width(340.0)
                .on_change(cx.listener(move |this, value: &SharedString, _, cx| this.assign(provider, value, cx)));
        let _ = scope;

        let note = if missing {
            Some("The assigned account is unavailable. Choose another saved account.".to_string())
        } else if needs_sign_in {
            effective.map(|entry| format!("{} \u{b7} {}", entry.title(), super::model::status_label(entry.account.state)))
        } else {
            None
        };
        let reauth_id =
            effective.filter(|entry| needs_sign_in && entry.id() != super::model::DEFAULT_ACCOUNT).map(|entry| entry.id().to_string());
        let signing_in = cx.global::<AccountsStore>().signing_in();
        let busy = self.busy;

        div()
            .debug_selector(move || format!("accounts-project-row-{key}"))
            .flex()
            .flex_col()
            .gap(px(6.0))
            .px(px(16.0))
            .py(px(12.0))
            .child(
                div()
                    .flex()
                    .min_h(px(32.0))
                    .items_center()
                    .justify_between()
                    .gap(px(16.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .text_step(TEXT_13)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink)
                            .child(ProviderLogo::new(provider).size(18.0))
                            .child(name),
                    )
                    .child(select),
            )
            .when_some(note, |el, note| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .pl(px(28.0))
                        .child(div().text_step(TEXT_12).text_color(theme.red_ink).child(note))
                        .when_some(reauth_id, |el, id| {
                            el.child(
                                Button::new(SharedString::from(format!("accounts-project-reauth-{key}")), "Re-authenticate")
                                    .variant(ButtonVariant::Link)
                                    .size(ButtonSize::S24)
                                    .disabled(busy || signing_in)
                                    .on_click(cx.listener(move |this, _, _, cx| this.act(Action::Login, provider, &id, cx))),
                            )
                        }),
                )
            })
            .when_some(effective.filter(|_| !missing).and_then(|entry| entry.message.clone()), |el, message| {
                el.child(div().pl(px(28.0)).text_step(TEXT_12).text_color(theme.ink3).child(message))
            })
            .into_any_element()
    }
}

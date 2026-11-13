//! The Plan usage tab (`AccountUsageSection.tsx`): one card per provider, every account of it with its limits.

use gpui::{AnyElement, Context, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::model::{AccountsStore, DEFAULT_ACCOUNT};
use super::plan::{PlanAccount, PlanGroup};
use super::style::{BarTone, percent_ink, shadow_card, tone_of, usage_bar};
use super::usage::{UsageView, ZONE};
use crate::data::{LOCAL, Provider};
use crate::logic::usage::report::{UsageDisplay, format_percent, format_resets_at, format_updated_ago, shown_percent, shown_suffix};
use crate::settings::store::{SettingsStore, UsageDisplayMode};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, ProviderLogo, Select, SelectOption, SpinnerRing};

/// The window a cached read is shown against: the fixture clock.
pub const NOW: i64 = crate::data::fixture::NOW;

impl UsageView {
    /// The display select and the refresh button, right of the tabs.
    pub(super) fn plan_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let mode = cx.global::<SettingsStore>().usage_display_mode;
        let select = Select::new(
            "usage-plan-display",
            mode.as_str(),
            [SelectOption::new("used", "Used"), SelectOption::new("remaining", "Remaining")],
        )
        .compact()
        .width(128.0)
        .on_change(|value, _, cx| {
            cx.update_global::<SettingsStore, _>(|store, _| store.usage_display_mode = UsageDisplayMode::parse(value));
        });
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(select)
            .child(
                IconButton::new("usage-plan-refresh", IconName::Refresh)
                    .size(IconButtonSize::S32)
                    .disabled(self.plan_loading)
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_plan(cx))),
            )
            .into_any_element()
    }

    pub(super) fn plan_body(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let display = Self::display(cx);
        let default_ids: Vec<(Provider, String)> =
            cx.global::<AccountsStore>().groups.iter().map(|group| (group.provider, group.selected_id.clone())).collect();
        let groups = self.plan.groups();
        let cards: Vec<AnyElement> = groups.iter().map(|group| self.plan_card(group, &default_ids, display, cx)).collect();
        let updated = self.plan.updated_at();
        let manage = self.is_local();

        div()
            .debug_selector(|| "usage-plan".into())
            .flex()
            .flex_col()
            .gap(px(16.0))
            .children(cards)
            .when(groups.is_empty() && self.plan.error.is_none(), |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .text_step(TEXT_13)
                        .text_color(theme.ink3)
                        .when(self.plan_loading, |el| el.child(SpinnerRing::new().size(16.0)))
                        .child(if self.plan_loading {
                            "Checking account usage\u{2026}"
                        } else {
                            "No connected accounts. Sign in to a provider in Accounts to see its plan usage."
                        }),
                )
            })
            .when_some(self.plan.error.clone(), |el, error| el.child(div().text_step(TEXT_12).text_color(theme.orange_ink).child(error)))
            .when(updated.is_some() || manage, |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(16.0))
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .child(updated.map(|at| format_updated_ago(&at, NOW)).unwrap_or_default())
                        .when(manage, |el| {
                            el.child(
                                div()
                                    .id("usage-manage-accounts")
                                    .debug_selector(|| "usage-manage-accounts".into())
                                    .flex()
                                    .items_center()
                                    .min_h(px(24.0))
                                    .px(px(8.0))
                                    .rounded(RADIUS_CONTROL)
                                    .cursor_pointer()
                                    .text_step(TEXT_12)
                                    .hover(move |style| style.bg(theme.hover).text_color(theme.ink))
                                    .on_click(cx.listener(|this, _, _, cx| this.manage_accounts(cx)))
                                    .child("Manage accounts"),
                            )
                        }),
                )
            })
            .into_any_element()
    }

    fn plan_card(
        &self,
        group: &PlanGroup<'_>,
        defaults: &[(Provider, String)],
        display: UsageDisplay,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = *cx.theme();
        let provider = group.provider;
        let count = group.accounts.len();
        let noun = if count == 1 { "account" } else { "accounts" };
        let default_id =
            defaults.iter().find(|(candidate, _)| *candidate == provider).map(|(_, id)| id.as_str()).unwrap_or(DEFAULT_ACCOUNT);
        let error = self.errors.get(&provider).filter(|text| !text.is_empty()).cloned();
        let last = group.accounts.len().saturating_sub(1);
        let entries: Vec<AnyElement> = group
            .accounts
            .iter()
            .enumerate()
            .map(|(index, entry)| self.plan_entry(provider, entry, entry.id() == default_id, index == last, display, cx))
            .collect();

        div()
            .debug_selector(move || format!("usage-plan-{}", provider.id()))
            .min_w_0()
            .flex()
            .flex_col()
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(shadow_card(&theme))
            .p(px(16.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .pb(px(12.0))
                    .text_step(TEXT_15)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.ink)
                    .child(ProviderLogo::new(provider).size(16.0))
                    .child(provider.name())
                    .child(
                        div().text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child(format!("{count} {noun}")),
                    ),
            )
            .when_some(error, |el, error| el.child(div().pt(px(8.0)).text_step(TEXT_12).text_color(theme.orange_ink).child(error)))
            .child(div().flex().flex_col().children(entries))
            .into_any_element()
    }

    fn plan_entry(
        &self,
        provider: Provider,
        entry: &PlanAccount,
        is_default: bool,
        last: bool,
        display: UsageDisplay,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = *cx.theme();
        let id = entry.id().to_string();
        let group_name = SharedString::from(format!("usage-entry-{}-{id}", provider.id()));
        let can_default = self.computer() == LOCAL && entry.state == super::model::AccountState::Ready && !is_default;
        let pending_here = self.pending.as_ref().is_some_and(|(p, pending)| *p == provider && *pending == id);
        let stale = entry.stale();
        let label = entry.label().to_string();
        let message_is_error = entry.usage.status == crate::data::UsageStatus::Error;

        let default_chip = is_default.then(|| div().flex_none().text_step(TEXT_11).text_color(theme.ink2).child("Default"));
        let set_default = can_default.then(|| {
            let tooltip = format!("Computer default on {}. Project and Link choices stay.", self.this_mac);
            let click_id = id.clone();
            div().flex_none().w(px(112.0)).h(px(24.0)).child(
                div()
                    .id(SharedString::from(format!("usage-set-default-{}-{id}", provider.id())))
                    .debug_selector({
                        let key = format!("usage-set-default-{}-{id}", provider.id());
                        move || key.clone()
                    })
                    .flex()
                    .items_center()
                    .justify_center()
                    .size_full()
                    .rounded(RADIUS_CONTROL)
                    .border_1()
                    .border_color(theme.line)
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink)
                    .cursor_pointer()
                    .opacity(if self.pending.is_some() { 0.4 } else { 0.0 })
                    .group_hover(group_name.clone(), |style| style.opacity(if pending_here { 0.4 } else { 1.0 }))
                    .hover(move |style| style.bg(theme.hover))
                    .tooltip(crate::ui::Tooltip::text(tooltip))
                    .on_click(cx.listener(move |this, _, _, cx| this.set_default(provider, &click_id, cx)))
                    .child("Set as default"),
            )
        });

        let left = div()
            .min_w_0()
            .w(px(302.0))
            .flex_none()
            .child(
                div()
                    .flex()
                    .min_h(px(24.0))
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .flex_1()
                            .items_baseline()
                            .gap(px(8.0))
                            .child(div().min_w_0().text_step(TEXT_13).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child(label))
                            .children(default_chip),
                    )
                    .children(set_default),
            )
            .when_some(entry.email().map(str::to_string), |el, email| {
                el.child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(email))
            })
            .when(stale, |el| {
                el.child(
                    div()
                        .mt(px(4.0))
                        .text_step(TEXT_11)
                        .text_color(theme.ink3)
                        .child(format!("Last known \u{b7} {}", format_updated_ago(&entry.usage.updated_at, NOW))),
                )
            });

        let windows: Vec<AnyElement> = entry
            .usage
            .windows
            .iter()
            .map(|window| {
                let tone = tone_of(window.used_percent);
                let bar_tone = if stale { BarTone::Stale } else { BarTone::Usage(tone) };
                let detail =
                    [window.detail.clone().filter(|text| !text.is_empty()), format_resets_at(window.resets_at.as_deref(), NOW, &ZONE)]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" \u{b7} ");
                let shown = format!("{} {}", format_percent(shown_percent(window.used_percent, display)), shown_suffix(display));
                div()
                    .debug_selector({
                        let key = format!("usage-window-{}-{id}-{}", provider.id(), window.id);
                        move || key.clone()
                    })
                    .min_w(px(200.0))
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_baseline()
                            .justify_between()
                            .gap_x(px(8.0))
                            .gap_y(px(4.0))
                            .text_step(TEXT_11)
                            .text_color(theme.ink3)
                            .child(window.label.clone())
                            .child(
                                div()
                                    .text_step(TEXT_13)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(percent_ink(&theme, tone))
                                    .child(shown),
                            ),
                    )
                    .child(usage_bar(&theme, window.used_percent, display, bar_tone, 4.0))
                    .child(div().text_step(TEXT_11).text_color(theme.ink3).child(detail))
                    .into_any_element()
            })
            .collect();

        let right = div()
            .min_w(px(240.0))
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .when(!windows.is_empty(), |el| el.child(div().flex().flex_wrap().gap_x(px(32.0)).gap_y(px(16.0)).children(windows)))
            .when_some(entry.usage.banked_resets.filter(|count| *count > 0), |el, count| {
                el.child(div().text_step(TEXT_12).text_color(theme.ink2).child(format!("Banked resets: {count} left")))
            })
            .when(entry.usage.windows.is_empty(), |el| {
                el.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .text_step(TEXT_13)
                        .text_color(theme.ink2)
                        .child(Icon::new(IconName::Alert02).size(IconSize::S16).color(theme.orange_ink))
                        .child("Usage unavailable"),
                )
            })
            .when_some(entry.message.clone(), |el, message| {
                el.child(div().text_step(TEXT_12).text_color(if message_is_error { theme.orange_ink } else { theme.ink3 }).child(message))
            });

        div()
            .id(SharedString::from(format!("usage-entry-id-{}-{id}", provider.id())))
            .group(group_name)
            .debug_selector({
                let key = format!("usage-entry-{}-{id}", provider.id());
                move || key.clone()
            })
            .min_w_0()
            .flex()
            .flex_wrap()
            .gap_x(px(32.0))
            .gap_y(px(16.0))
            .py(px(16.0))
            .when(!last, |el| el.border_b_1().border_color(theme.line))
            .when(last, |el| el.pb_0())
            .child(left)
            .child(right)
            .into_any_element()
    }
}

//! Settings › Usage in preview mode: the Plan usage cards (`AccountUsageSection.tsx`) for the accounts a data layer
//! read (`PreviewPlanUsage`), read-only. Each provider is a card; each of its accounts shows its name, email, last-known
//! note, and its windows with a meter, percent and reset; no "Set as default", no refresh, no computer picker, and no
//! Analytics tab (the token report is not read here). Times use this computer's zone and clock.

use gpui::{AnyElement, App, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::style::{BarTone, percent_ink, shadow_card, tone_of, usage_bar};
use crate::data::{AccountUsage, Provider, UsageStatus};
use crate::logic::usage::report::{UsageDisplay, account_usage_groups, format_percent, format_resets_at, format_updated_ago};
use crate::logic::usage::time::SystemZone;
use crate::settings::group::page_header;
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_11, TEXT_12, TEXT_13, TEXT_15, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, ProviderLogo};
use crate::workspace::preview::PreviewPlanUsage;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The page body.
pub fn render(cx: &App) -> AnyElement {
    let theme = *cx.theme();
    let usage = cx.global::<PreviewPlanUsage>();
    let snapshot = usage.0.report();
    let now = now_ms();
    let groups = account_usage_groups(Some(&snapshot));
    let message = |provider: Provider, account: &AccountUsage| {
        usage.0.providers.iter().find(|p| p.provider == provider && p.account == account.account).and_then(|p| p.message.clone())
    };
    let cards: Vec<AnyElement> = groups
        .iter()
        .map(|(provider, accounts)| {
            let count = accounts.len();
            let last = count.saturating_sub(1);
            let entries: Vec<AnyElement> = accounts
                .iter()
                .enumerate()
                .map(|(ix, account)| entry(*provider, account, message(*provider, account), ix == last, now, &theme))
                .collect();
            let provider = *provider;
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
                            div()
                                .text_step(TEXT_12)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink3)
                                .child(format!("{count} {}", if count == 1 { "account" } else { "accounts" })),
                        ),
                )
                .child(div().flex().flex_col().children(entries))
                .into_any_element()
        })
        .collect();
    div()
        .debug_selector(|| "settings-section-usage".into())
        .flex()
        .flex_col()
        .gap(px(16.0))
        .child(page_header("Usage".to_owned(), Some("Plan usage for every account"), cx))
        .when(cards.is_empty(), |el| el.child(div().text_step(TEXT_13).text_color(theme.ink3).child("No plan usage read yet.")))
        .children(cards)
        .child(
            div()
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child("Read from Milagre's daemon's saved numbers; Milagre refreshes them. The token report is not shown here yet."),
        )
        .into_any_element()
}

fn entry(provider: Provider, account: &AccountUsage, message: Option<SharedString>, last: bool, now: i64, theme: &Theme) -> AnyElement {
    let theme = *theme;
    let identity = account.account.as_ref();
    let id = identity.map_or("", |a| a.id.as_str()).to_owned();
    let label = identity.map(|a| a.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| "Account".to_owned());
    let email = identity.and_then(|a| a.email.clone()).filter(|e| !e.is_empty());
    let failed = account.status == UsageStatus::Error;
    let stale = failed && !account.windows.is_empty();
    let left = div()
        .min_w_0()
        .w(px(302.0))
        .flex_none()
        .child(
            div()
                .min_h(px(24.0))
                .flex()
                .items_center()
                .text_step(TEXT_13)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.ink)
                .child(label),
        )
        .when_some(email, |el, email| el.child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(email)))
        .when(stale, |el| {
            el.child(
                div()
                    .mt(px(4.0))
                    .text_step(TEXT_11)
                    .text_color(theme.ink3)
                    .child(format!("Last known \u{b7} {}", format_updated_ago(&account.updated_at, now))),
            )
        });
    let windows: Vec<AnyElement> = account
        .windows
        .iter()
        .map(|window| {
            let tone = tone_of(window.used_percent);
            let bar_tone = if stale { BarTone::Stale } else { BarTone::Usage(tone) };
            let detail =
                [window.detail.clone().filter(|text| !text.is_empty()), format_resets_at(window.resets_at.as_deref(), now, &SystemZone)]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" \u{b7} ");
            let key = format!("usage-window-{}-{id}-{}", provider.id(), window.id);
            div()
                .debug_selector(move || key.clone())
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
                                .child(format!("{} used", format_percent(window.used_percent))),
                        ),
                )
                .child(usage_bar(&theme, window.used_percent, UsageDisplay::Used, bar_tone, 4.0))
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
        .when_some(account.banked_resets.filter(|count| *count > 0), |el, count| {
            el.child(div().text_step(TEXT_12).text_color(theme.ink2).child(format!("Banked resets: {count} left")))
        })
        .when(account.windows.is_empty(), |el| {
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
        .when_some(message, |el, message| {
            el.child(div().text_step(TEXT_12).text_color(if failed { theme.orange_ink } else { theme.ink3 }).child(message))
        });
    let key = format!("usage-entry-{}-{id}", provider.id());
    div()
        .debug_selector(move || key.clone())
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

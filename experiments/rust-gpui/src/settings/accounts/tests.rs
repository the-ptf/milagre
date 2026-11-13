//! Headless tests for WP-42: the Accounts page (select, sign in, add, remove, limit switches, Per Project), plan
//! usage (display, set as default, refresh) and Analytics (tabs, periods, calendar selection with a drag, Escape,
//! project rows). The rules themselves are tested beside their code (`model.rs`, `token_usage.rs`).

use std::time::Duration;

use gpui::{BorrowAppContext, Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext};

use super::fixture;
use super::model::{AccountState, AccountsStore, DEFAULT_ACCOUNT};
use super::token_usage::{Days, Metric, Range, covered_days, token_total};
use super::usage::UsageTab;
use super::{AccountsView, UsageView};
use crate::data::Provider;
use crate::settings::search::SettingsSectionId;
use crate::settings::store::{SettingsStore, UsageDisplayMode};
use crate::testing;
use crate::workspace::Workspace;

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> gpui::Bounds<gpui::Pixels> {
    cx.debug_bounds(testing::leak(selector.to_string())).unwrap_or_else(|| panic!("`{selector}` is not drawn"))
}

fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(testing::leak(selector.to_string())).is_some()
}

/// Scrolls the body so the element is on screen, then clicks it.
fn click(cx: &mut VisualTestContext, workspace: &Entity<Workspace>, selector: &str) {
    let body = bounds(cx, "settings-main");
    let at = bounds(cx, selector);
    let overshoot = f32::from(at.bottom() - body.bottom()) + 80.0;
    if overshoot > 0.0 {
        let settings = workspace.read_with(cx, |w, _| w.settings.clone());
        let handle = settings.read_with(cx, |s, _| s.body_scroll().clone());
        let current = handle.offset();
        handle.set_offset(gpui::point(current.x, current.y - gpui::px(overshoot)));
        settle(cx);
    }
    let at = bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

fn open(cx: &mut TestAppContext, section: SettingsSectionId) -> (Entity<Workspace>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(section, window, cx));
    settle(cx);
    (workspace, cx)
}

fn views(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> (Entity<AccountsView>, Entity<UsageView>) {
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.read_with(cx, |s, _| (s.accounts.clone(), s.usage.clone()))
}

fn store(cx: &mut VisualTestContext) -> AccountsStore {
    cx.update(|_, cx| cx.global::<AccountsStore>().clone())
}

fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

#[gpui::test]
fn the_accounts_page_draws_every_provider_and_the_default_follows_a_click(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Accounts);
    for provider in ["codex", "claude", "antigravity", "kiro"] {
        assert!(drawn(cx, &format!("accounts-card-{provider}")), "{provider} card");
    }
    assert!(drawn(cx, "accounts-antigravity-row") && drawn(cx, "accounts-per-project"));
    assert!(!drawn(cx, "accounts-add-antigravity") && drawn(cx, "accounts-add-claude") && !drawn(cx, "accounts-add-kiro"));
    assert!(!drawn(cx, "account-remove-claude-default"), "the CLI's own account can not be removed");
    click(cx, &workspace, "account-select-claude-claude-work");
    assert_eq!(store(cx).group(Provider::Claude).unwrap().selected_id, "claude-work");
    // A signed-out account can not be picked.
    click(cx, &workspace, "account-select-codex-codex-old");
    assert_eq!(store(cx).group(Provider::Codex).unwrap().selected_id, DEFAULT_ACCOUNT);
}

#[gpui::test]
fn adding_an_account_names_it_signs_in_for_a_moment_and_removing_it_takes_it_away(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Accounts);
    click(cx, &workspace, "accounts-add-claude");
    let (accounts, _) = views(&workspace, cx);
    assert_eq!(accounts.read_with(cx, |v, _| v.adding()), Some(Provider::Claude));
    assert!(drawn(cx, "accounts-add-form"));
    // Nothing typed: the button is inert.
    click(cx, &workspace, "accounts-add-continue");
    assert_eq!(accounts.read_with(cx, |v, _| v.adding()), Some(Provider::Claude));
    let input = accounts.read_with(cx, |v, _| v.name_input()).unwrap();
    input.update_in(cx, |state, window, cx| state.set_value("Side project", window, cx));
    settle(cx);
    click(cx, &workspace, "accounts-add-continue");
    assert_eq!(accounts.read_with(cx, |v, _| v.adding()), None);
    let added = store(cx).group(Provider::Claude).unwrap().accounts.iter().find(|a| a.account.label == "Side project").cloned().unwrap();
    assert_eq!(added.account.state, AccountState::SigningIn);
    assert!(drawn(cx, &format!("account-cancel-claude-{}", added.id())));
    advance(cx, 1600);
    assert_eq!(store(cx).group(Provider::Claude).unwrap().find(added.id()).unwrap().account.state, AccountState::Ready);
    click(cx, &workspace, &format!("account-remove-claude-{}", added.id()));
    assert!(store(cx).group(Provider::Claude).unwrap().find(added.id()).is_none());
}

#[gpui::test]
fn signing_in_again_can_be_cancelled_and_antigravity_installs_in_steps(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Accounts);
    click(cx, &workspace, "account-login-codex-codex-old");
    assert_eq!(store(cx).group(Provider::Codex).unwrap().find("codex-old").unwrap().account.state, AccountState::SigningIn);
    click(cx, &workspace, "account-cancel-codex-codex-old");
    assert_eq!(store(cx).group(Provider::Codex).unwrap().find("codex-old").unwrap().account.state, AccountState::SignedOut);
    advance(cx, 1600);
    assert_eq!(
        store(cx).group(Provider::Codex).unwrap().find("codex-old").unwrap().account.state,
        AccountState::SignedOut,
        "cancelled stays"
    );

    click(cx, &workspace, "accounts-antigravity-install");
    assert!(store(cx).cli.working);
    assert!(!drawn(cx, "accounts-add-antigravity"));
    advance(cx, 600);
    assert!(store(cx).cli.working && store(cx).cli.percent() > 0.05);
    advance(cx, 2000);
    let after = store(cx);
    assert!(!after.cli.working && after.group(Provider::Antigravity).unwrap().installed);
    assert!(drawn(cx, "accounts-add-antigravity"), "installed: accounts can be added");
}

#[gpui::test]
fn the_limit_switches_write_the_settings_store(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Accounts);
    let read = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| (cx.global::<SettingsStore>().limit_auto_switch, cx.global::<SettingsStore>().limit_resume_at_reset))
    };
    assert_eq!(read(cx), (false, true));
    click(cx, &workspace, "settings-row-switch-accounts-at-usage-limits");
    click(cx, &workspace, "settings-row-continue-when-the-limit-resets");
    assert_eq!(read(cx), (true, false));
}

#[gpui::test]
fn a_project_picks_an_account_and_the_scope_switches(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Accounts);
    let (accounts, _) = views(&workspace, cx);
    let scope = accounts.read_with(cx, |v, cx| v.scope(cx));
    assert_eq!(scope, "~chats", "the Chats home leads");
    accounts.update(cx, |v, cx| v.assign(Provider::Claude, "claude-work", cx));
    settle(cx);
    let view = store(cx).project_accounts("~chats").into_iter().find(|p| p.provider == Provider::Claude).unwrap();
    assert_eq!(view.account_id.as_deref(), Some("claude-work"));
    accounts.update(cx, |v, cx| v.assign(Provider::Claude, "", cx));
    assert_eq!(store(cx).project_accounts("~chats").into_iter().find(|p| p.provider == Provider::Claude).unwrap().account_id, None);
    assert!(drawn(cx, "accounts-project-row-codex") && !drawn(cx, "accounts-project-row-antigravity"), "only installed providers");
    accounts.update(cx, |v, cx| v.set_scope("link:desktop-phone", cx));
    settle(cx);
    assert_eq!(accounts.read_with(cx, |v, cx| v.scope(cx)), "link:desktop-phone");
}

#[gpui::test]
fn plan_usage_groups_accounts_and_the_display_switch_reads_remaining(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Usage);
    for provider in ["codex", "claude", "antigravity", "kiro"] {
        assert!(drawn(cx, &format!("usage-plan-{provider}")), "{provider} card");
    }
    assert!(drawn(cx, "usage-window-claude-default-five_hour") && drawn(cx, "usage-window-claude-claude-work-seven_day"));
    assert!(!drawn(cx, "usage-window-codex-codex-old-weekly"), "no numbers for a signed-out account");
    let (_, usage) = views(&workspace, cx);
    assert_eq!(usage.read_with(cx, |v, _| v.tab()), UsageTab::Plan);
    cx.update(|_, cx| cx.update_global::<SettingsStore, _>(|s, _| s.usage_display_mode = UsageDisplayMode::Remaining));
    settle(cx);
    assert_eq!(UsageDisplayMode::Remaining.as_str(), "remaining");
    assert!(drawn(cx, "usage-window-codex-default-weekly"));
}

#[gpui::test]
fn set_as_default_changes_the_computer_default_and_refresh_reads_again(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Usage);
    // Hidden until the row is hovered, but it is there to click.
    click(cx, &workspace, "usage-set-default-claude-claude-work");
    advance(cx, 500);
    assert_eq!(store(cx).group(Provider::Claude).unwrap().selected_id, "claude-work");
    assert!(!drawn(cx, "usage-set-default-claude-claude-work"), "now the default");
    assert!(drawn(cx, "usage-set-default-claude-default"));
    click(cx, &workspace, "usage-plan-refresh");
    let (_, usage) = views(&workspace, cx);
    assert!(usage.read_with(cx, |v, _| v.plan_loading_for_test()));
    advance(cx, 600);
    assert!(!usage.read_with(cx, |v, _| v.plan_loading_for_test()));
}

#[gpui::test]
fn analytics_scans_first_then_a_period_and_the_metric_change_the_numbers(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Usage);
    click(cx, &workspace, "usage-tab-analytics");
    let (_, usage) = views(&workspace, cx);
    assert!(usage.read_with(cx, |v, _| v.report().is_none()) && drawn(cx, "usage-loading"));
    advance(cx, 400);
    assert!(usage.read_with(cx, |v, _| v.report().is_some()));
    for part in ["usage-total", "usage-calendar", "usage-where", "usage-models", "usage-token-mix"] {
        assert!(drawn(cx, part), "{part}");
    }
    let week = usage.read_with(cx, |v, _| token_total(&v.report().unwrap().totals));
    click(cx, &workspace, "usage-period-30d");
    let month = usage.read_with(cx, |v, _| token_total(&v.report().unwrap().totals));
    assert!(month > week * 2.0, "30 days hold more than 7");
    assert_eq!(usage.read_with(cx, |v, _| v.range()), Range::Month);
    click(cx, &workspace, "usage-metric-tokens");
    assert_eq!(usage.read_with(cx, |v, _| v.metric()), Metric::Tokens);
}

#[gpui::test]
fn the_calendar_picks_a_day_with_a_click_and_a_span_with_a_drag_and_escape_clears_it(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Usage);
    click(cx, &workspace, "usage-tab-analytics");
    advance(cx, 400);
    let (_, usage) = views(&workspace, cx);
    let keys: Vec<String> = usage.read_with(cx, |v, _| v.report().unwrap().calendar.iter().map(|d| d.key.clone()).collect());
    let (a, b, c) = (&keys[keys.len() - 20], &keys[keys.len() - 14], &keys[keys.len() - 16]);
    let whole = usage.read_with(cx, |v, _| token_total(&v.report().unwrap().totals));

    click(cx, &workspace, &format!("usage-day-{a}"));
    assert_eq!(usage.read_with(cx, |v, _| v.days().cloned()), Some(Days::one(a)));
    let one = usage.read_with(cx, |v, _| token_total(&v.report().unwrap().totals));
    assert!(one < whole, "one day is less than a week");
    assert!(drawn(cx, "usage-clear-days"));

    // Drag from b back to c: the span reads in order.
    let from = bounds(cx, &format!("usage-day-{b}")).center();
    let to = bounds(cx, &format!("usage-day-{c}")).center();
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::none());
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::none());
    settle(cx);
    assert_eq!(usage.read_with(cx, |v, _| v.dragging().cloned()), Some(Days { from: b.clone(), to: c.clone() }));
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::none());
    settle(cx);
    assert_eq!(usage.read_with(cx, |v, _| v.days().cloned()), Some(Days { from: c.clone(), to: b.clone() }));
    let covered = usage.read_with(cx, |v, _| {
        let r = v.report().unwrap();
        covered_days(&r.calendar, r.since, r.until).len()
    });
    assert_eq!(covered, 3);

    cx.simulate_keystrokes("escape");
    settle(cx);
    assert_eq!(usage.read_with(cx, |v, _| v.days().cloned()), None);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    assert!(settings.read_with(cx, |s, _| s.is_open()), "Escape cleared the days and stayed on the page");
}

#[gpui::test]
fn projects_open_and_close_and_show_the_rest_of_their_chats(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Usage);
    click(cx, &workspace, "usage-tab-analytics");
    advance(cx, 400);
    let (_, usage) = views(&workspace, cx);
    let (first, second) = usage.read_with(cx, |v, _| {
        let r = v.report().unwrap();
        (r.projects[0].clone(), r.projects[1].clone())
    });
    assert!(usage.read_with(cx, |v, _| v.project_open(first.key(), 0)));
    assert!(!usage.read_with(cx, |v, _| v.project_open(second.key(), 1)));
    assert!(first.chats.len() > 5 && first.more.is_some(), "the top Project has more Chats than it first lists");
    assert!(drawn(cx, &format!("usage-more-{}", first.key())));
    click(cx, &workspace, &format!("usage-more-{}", first.key()));
    assert!(!drawn(cx, &format!("usage-more-{}", first.key())));
    click(cx, &workspace, &format!("usage-project-{}", second.key()));
    assert!(usage.read_with(cx, |v, _| v.project_open(second.key(), 1)));
    click(cx, &workspace, &format!("usage-project-{}", first.key()));
    assert!(!usage.read_with(cx, |v, _| v.project_open(first.key(), 0)));
}

#[gpui::test]
fn another_computer_reads_its_own_numbers_and_has_no_set_as_default(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Usage);
    let (_, usage) = views(&workspace, cx);
    let other = usage.read_with(cx, |v, _| v.computer_ids_for_test().into_iter().find(|id| id != crate::data::LOCAL));
    let Some(other) = other else { return };
    usage.update(cx, |v, cx| v.set_computer(&other, cx));
    settle(cx);
    assert!(!usage.read_with(cx, |v, _| v.is_local()));
    assert!(!drawn(cx, "usage-set-default-codex-default") && !drawn(cx, "usage-manage-accounts"));
    assert!(!drawn(cx, "usage-plan-claude"), "that computer reported Codex only");
}

#[test]
fn the_fixture_report_is_consistent_across_periods() {
    let day = fixture::token_report(Range::Day, None, 1.0);
    let week = fixture::token_report(Range::Week, None, 1.0);
    let quarter = fixture::token_report(Range::Quarter, None, 1.0);
    assert!(token_total(&day.totals) < token_total(&week.totals) && token_total(&week.totals) < token_total(&quarter.totals));
    for report in [&day, &week, &quarter] {
        let by_project: f64 = report.projects.iter().map(|p| p.totals.cost_usd).sum();
        assert!((by_project - report.totals.cost_usd).abs() < 1e-6 * report.totals.cost_usd.max(1.0), "projects add up");
        let by_provider: f64 = report.providers.iter().map(|(_, t)| t.cost_usd).sum();
        assert!((by_provider - report.totals.cost_usd).abs() < 1e-6 * report.totals.cost_usd.max(1.0));
        assert_eq!(report.calendar.len(), 90);
    }
    assert!(week.models.iter().any(|m| !m.priced) && week.totals.unpriced_tokens > 0.0);
    let one = fixture::token_report(Range::Week, Some(&Days::one(&week.calendar[40].key)), 1.0);
    assert!(token_total(&one.totals) > 0.0 && token_total(&one.totals) < token_total(&week.totals));
    assert_eq!(fixture::covered(&one).len(), 1);
}

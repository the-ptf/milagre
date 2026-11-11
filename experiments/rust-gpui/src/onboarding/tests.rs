use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::fixture::{self, Scenario};
use super::model::*;
use super::{FormKind, Onboarding, OnboardingEvent, OnboardingLayer};
use crate::data::Provider;
use crate::testing;

fn mount(cx: &mut TestAppContext, scenario: Scenario) -> (Entity<Onboarding>, Rc<RefCell<Vec<OnboardingEvent>>>, &mut VisualTestContext) {
    let (view, cx) = testing::mount_in_root(cx, move |window, cx| {
        let mut view = Onboarding::new(window, cx);
        view.apply(scenario, window, cx);
        view
    });
    let events = Rc::new(RefCell::new(Vec::new()));
    let log = events.clone();
    cx.update(|_, cx| cx.subscribe(&view, move |_, event: &OnboardingEvent, _| log.borrow_mut().push(event.clone())).detach());
    (view, events, cx)
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = testing::bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
}

fn elapse(cx: &mut VisualTestContext, by: Duration) {
    cx.executor().advance_clock(by);
    cx.run_until_parked();
}

fn state(rows: &[AgentRow], provider: Provider) -> RowState {
    rows.iter().find(|row| row.provider == provider).unwrap().state
}

// ---- rules ----

#[test]
fn every_agent_gets_the_row_its_status_says() {
    assert!(agent_rows(None).iter().all(|row| row.state == RowState::Checking && row.detail == "Checking this Mac\u{2026}"));
    let rows = agent_rows(Some(&fixture::agents()));
    assert_eq!(rows.iter().map(|row| row.provider).collect::<Vec<_>>(), PROVIDERS);
    assert_eq!(state(&rows, Provider::Claude), RowState::Ready);
    assert_eq!(rows[0].detail, "Signed in \u{b7} Max plan");
    assert_eq!(state(&rows, Provider::Codex), RowState::SignedOut);
    assert_eq!(rows[1].detail, "Installed \u{b7} not signed in");
    assert_eq!(state(&rows, Provider::Antigravity), RowState::Missing);
    assert_eq!(rows[2].detail, "Not found on this Mac");
}

#[test]
fn broken_outdated_signing_in_and_failed_sign_ins() {
    let fact = |cli, account: Option<Account>| vec![AgentFacts { provider: Provider::Claude, cli, account }];
    let account = |state, message: Option<&str>| Account { id: "a".into(), state, plan: None, message: message.map(Into::into) };
    let row = |facts: Vec<AgentFacts>| agent_rows(Some(&facts)).remove(0);
    assert_eq!(row(fact(CliState::Broken, None)).detail, "Installed, but it doesn\u{2019}t start");
    assert_eq!(row(fact(CliState::Outdated, None)).state, RowState::Outdated);
    assert_eq!(row(fact(CliState::Ready, Some(account(AccountState::SigningIn, None)))).detail, "Finish signing in in your browser");
    let failed = row(fact(CliState::Ready, Some(account(AccountState::Error, Some("Token expired")))));
    assert_eq!((failed.state, failed.detail.as_str()), (RowState::SignedOut, "Token expired"));
    assert_eq!(row(fact(CliState::Ready, Some(account(AccountState::SignedIn, None)))).detail, "Signed in");
}

#[test]
fn a_self_installed_agent_says_how_to_install_it() {
    let rows = agent_rows(Some(&fixture::agents()));
    let kiro = rows.iter().find(|row| row.provider == Provider::Kiro).unwrap();
    assert_eq!(row_detail(kiro, false), "Not found on this Mac \u{b7} install it with Homebrew");
    assert_eq!(row_detail(kiro, true), "Copied. Run it in a terminal, then come back here.");
    assert_eq!(self_installed(Provider::Kiro).unwrap().install, Some("brew install --cask kiro-cli"));
    assert!(self_installed(Provider::Claude).is_none());
}

#[test]
fn paths_dates_and_names_read_the_way_people_say_them() {
    assert_eq!(home_path("/Users/me/Code/web"), "~/Code/web");
    assert_eq!(home_path("/home/me"), "~");
    assert_eq!(home_path("/opt/x"), "/opt/x");
    assert_eq!(in_code("app"), "~/Code/app");
    let labels: Vec<_> = [0, 1, 3, 8, 20].into_iter().map(last_used_label).collect();
    assert_eq!(labels, ["today", "yesterday", "3 days ago", "last week", "2 weeks ago"]);
    assert_eq!(repository_name("https://github.com/the-ptf/milagre.git"), "milagre");
    assert_eq!(repository_name("git@github.com:owner/repo/"), "repo");
    assert_eq!(sources(&fixture::folders()), ["Claude", "Codex"]);
}

#[test]
fn the_first_chat_offers_three_starters_named_for_the_project() {
    let starters = first_chat_starters("happiergym");
    assert_eq!(starters.iter().map(|s| s.id).collect::<Vec<_>>(), ["explain", "bug", "tests"]);
    assert_eq!(starters[0].label, "Explain how happiergym is put together");
    assert!(starters[0].prompt.starts_with("Explain how happiergym is put together: its main parts"));
    assert_eq!(starters[1].prompt, "Look through this project for a real bug, explain it, and fix it.");
}

// ---- step 1 ----

#[gpui::test]
fn the_agent_step_lists_the_agents_and_continues_with_the_ready_one(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::Agent);
    for id in ["claude", "codex", "antigravity", "kiro"] {
        assert!(cx.debug_bounds(testing::leak(format!("agent-row-{id}"))).is_some(), "{id}");
    }
    assert_eq!(view.read_with(cx, |v, _| v.ready_agent()), Some(Provider::Claude));
    assert!(cx.debug_bounds("agent-copy-kiro").is_some(), "Kiro copies a command");
    assert!(cx.debug_bounds("agent-act-antigravity").is_some() && cx.debug_bounds("agent-act-codex").is_some());
    click(cx, "onboarding-continue");
    assert_eq!(view.read_with(cx, |v, _| v.step()), Step::Project);
}

#[gpui::test]
fn set_up_later_also_goes_to_the_project_step(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::AgentChecking);
    assert!(view.read_with(cx, |v, _| v.rows().iter().all(|row| row.state == RowState::Checking)));
    click(cx, "onboarding-later");
    assert_eq!(view.read_with(cx, |v, _| v.step()), Step::Project);
}

#[gpui::test]
fn installing_then_signing_in_makes_an_agent_ready(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::Agent);
    click(cx, "agent-act-antigravity");
    assert_eq!(view.read_with(cx, |v, _| v.working()), Some(Provider::Antigravity));
    elapse(cx, Duration::from_secs(2));
    assert_eq!(state(&view.read_with(cx, |v, _| v.rows()), Provider::Antigravity), RowState::SignedOut);
    click(cx, "agent-act-antigravity");
    assert_eq!(state(&view.read_with(cx, |v, _| v.rows()), Provider::Antigravity), RowState::SigningIn);
    elapse(cx, Duration::from_secs(3));
    assert_eq!(state(&view.read_with(cx, |v, _| v.rows()), Provider::Antigravity), RowState::Ready);
}

#[gpui::test]
fn cancelling_a_sign_in_goes_back_to_signed_out(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::AgentSigningIn);
    assert_eq!(state(&view.read_with(cx, |v, _| v.rows()), Provider::Codex), RowState::SigningIn);
    click(cx, "agent-act-codex");
    elapse(cx, Duration::from_secs(3));
    assert_eq!(
        state(&view.read_with(cx, |v, _| v.rows()), Provider::Codex),
        RowState::SignedOut,
        "the browser finish does nothing after Cancel"
    );
}

#[gpui::test]
fn copying_a_command_puts_it_on_the_clipboard(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::Agent);
    click(cx, "agent-copy-kiro");
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()), Some("brew install --cask kiro-cli".to_string()));
    let _ = view;
}

// ---- step 2 ----

#[gpui::test]
fn the_project_step_lists_folders_and_a_git_folder_opens_at_once(cx: &mut TestAppContext) {
    let (view, events, cx) = mount(cx, Scenario::Project);
    for selector in [
        "onboarding-tile-open",
        "onboarding-tile-clone",
        "onboarding-tile-create",
        "onboarding-folders",
        "folder-happiergym",
        "folder-recipes",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    click(cx, "folder-happiergym");
    assert!(view.read_with(cx, |v, _| v.is_busy()));
    elapse(cx, Duration::from_secs(1));
    assert_eq!(
        events.borrow().as_slice(),
        [OnboardingEvent::Opened { name: "happiergym".into(), path: "/Users/me/Code/happiergym".into() }]
    );
}

#[gpui::test]
fn a_folder_without_git_explains_and_offers_both_ways(cx: &mut TestAppContext) {
    let (view, events, cx) = mount(cx, Scenario::Project);
    click(cx, "folder-recipes");
    assert_eq!(view.read_with(cx, |v, _| v.expanded().map(str::to_string)), Some("/Users/me/Documents/recipes".to_string()));
    assert!(cx.debug_bounds("onboarding-no-git").is_some());
    click(cx, "no-git-setup");
    elapse(cx, Duration::from_secs(1));
    assert!(matches!(events.borrow().as_slice(), [OnboardingEvent::Opened { path, .. }] if path.ends_with("recipes")));
}

#[gpui::test]
fn the_no_git_card_toggles_and_opens_the_folder_as_it_is(cx: &mut TestAppContext) {
    let (view, events, cx) = mount(cx, Scenario::ProjectNoGit);
    assert!(cx.debug_bounds("onboarding-no-git").is_some());
    click(cx, "folder-recipes");
    assert_eq!(view.read_with(cx, |v, _| v.expanded().map(str::to_string)), None, "a second click closes it");
    click(cx, "folder-recipes");
    click(cx, "no-git-open");
    elapse(cx, Duration::from_secs(1));
    assert_eq!(events.borrow().len(), 1);
}

#[gpui::test]
fn the_clone_form_opens_a_project_named_for_the_repository(cx: &mut TestAppContext) {
    let (view, events, cx) = mount(cx, Scenario::ProjectClone);
    assert_eq!(view.read_with(cx, |v, _| v.form()), Some(FormKind::Clone));
    assert!(cx.debug_bounds("onboarding-form").is_some());
    click(cx, "onboarding-submit");
    assert!(view.read_with(cx, |v, _| v.is_busy()), "Cloning\u{2026}");
    elapse(cx, Duration::from_secs(1));
    assert_eq!(events.borrow().as_slice(), [OnboardingEvent::Opened { name: "milagre".into(), path: "~/Code/milagre".into() }]);
}

#[gpui::test]
fn the_create_form_names_the_folder_it_makes(cx: &mut TestAppContext) {
    let (_, events, cx) = mount(cx, Scenario::ProjectCreate);
    click(cx, "onboarding-submit");
    elapse(cx, Duration::from_secs(1));
    assert_eq!(events.borrow().as_slice(), [OnboardingEvent::Opened { name: "weekend-app".into(), path: "~/Code/weekend-app".into() }]);
}

#[gpui::test]
fn an_empty_form_cannot_be_submitted_and_closes(cx: &mut TestAppContext) {
    let (view, events, cx) = mount(cx, Scenario::Project);
    click(cx, "onboarding-tile-create");
    assert_eq!(view.read_with(cx, |v, _| v.form()), Some(FormKind::Create));
    view.update(cx, |v, cx| v.submit(cx));
    elapse(cx, Duration::from_secs(1));
    assert!(events.borrow().is_empty());
    click(cx, "onboarding-form-close");
    assert_eq!(view.read_with(cx, |v, _| v.form()), None);
    assert!(cx.debug_bounds("onboarding-form").is_none());
}

#[gpui::test]
fn open_folder_and_skip_end_the_step(cx: &mut TestAppContext) {
    let (_, events, cx) = mount(cx, Scenario::Project);
    click(cx, "onboarding-tile-open");
    elapse(cx, Duration::from_secs(1));
    assert!(matches!(events.borrow().as_slice(), [OnboardingEvent::Opened { .. }]));
    click(cx, "onboarding-skip");
    assert_eq!(events.borrow().last(), Some(&OnboardingEvent::Skip));
}

#[gpui::test]
fn back_returns_to_the_agent_step(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::Project);
    click(cx, "onboarding-back");
    assert_eq!(view.read_with(cx, |v, _| v.step()), Step::Agent);
}

#[gpui::test]
fn no_agent_history_leaves_out_the_recent_list(cx: &mut TestAppContext) {
    let (_, _, cx) = mount(cx, Scenario::ProjectEmpty);
    assert!(cx.debug_bounds("onboarding-folders").is_none());
    assert!(cx.debug_bounds("onboarding-tile-open").is_some());
}

#[gpui::test]
fn while_the_history_loads_the_list_shows_placeholders(cx: &mut TestAppContext) {
    let (view, _, cx) = mount(cx, Scenario::ProjectLoading);
    assert!(cx.debug_bounds("onboarding-folders").is_some());
    assert!(view.read_with(cx, |v, _| v.folders().is_none()));
}

#[gpui::test]
fn the_screen_opens_with_the_answers_arriving_a_moment_later(cx: &mut TestAppContext) {
    let (view, cx) = testing::mount_in_root(cx, Onboarding::new);
    assert!(view.read_with(cx, |v, _| v.rows().iter().all(|row| row.state == RowState::Checking)));
    elapse(cx, Duration::from_secs(1));
    assert_eq!(state(&view.read_with(cx, |v, _| v.rows()), Provider::Claude), RowState::Ready);
    assert_eq!(view.read_with(cx, |v, _| v.folders().map(<[_]>::len)), Some(4));
}

#[gpui::test]
fn the_sky_thins_on_the_second_step_and_the_starters_pick(cx: &mut TestAppContext) {
    assert_eq!(super::sky::opacity(Step::Agent), 1.0);
    assert_eq!(super::sky::opacity(Step::Project), 0.7);
    let (_, _, cx) = mount(cx, Scenario::FirstChat);
    for id in ["starter-explain", "starter-bug", "starter-tests"] {
        assert!(cx.debug_bounds(id).is_some(), "{id}");
    }
}

#[gpui::test]
fn the_layer_draws_nothing_until_started_and_ends_with_the_skip(cx: &mut TestAppContext) {
    let (layer, cx) = testing::mount_in_root(cx, OnboardingLayer::new);
    assert!(!layer.read_with(cx, |l, _| l.is_active()));
    assert!(cx.debug_bounds("onboarding").is_none());
    cx.update(|window, cx| layer.update(cx, |l, cx| l.start(Some(Scenario::Project), window, cx)));
    cx.run_until_parked();
    assert!(cx.debug_bounds("onboarding").is_some());
    click(cx, "onboarding-skip");
    assert!(!layer.read_with(cx, |l, _| l.is_active()));
    assert!(cx.debug_bounds("onboarding").is_none());
}

#[test]
fn scenario_names_all_parse() {
    for name in [
        "agent",
        "agent-checking",
        "agent-signing-in",
        "project",
        "project-clone",
        "project-create",
        "project-nogit",
        "project-empty",
        "project-loading",
        "first-chat",
    ] {
        assert!(Scenario::from_name(name).is_some(), "{name}");
    }
}

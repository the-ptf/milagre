//! Headless tests for WP-43 Integrations: Linear (switch, workspaces, connect and disconnect, errors) and the
//! Babysit PRs page (immediate saves, autosaving text fields, failures, reset, the rules of the settings).

use gpui::{Entity, TestAppContext, VisualTestContext};

use super::babysit_model::*;
use super::linear::{CONNECT_MS, Connecting, Workspace as LinearWorkspace, status_line};
use super::{AUTOSAVE_MS, Field, IntegrationsView, Page, SAVE_MS};
use crate::settings::mcp::tests::{advance, click, drawn, open, settle};
use crate::settings::search::SettingsSectionId;
use crate::workspace::Workspace;

fn view(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<IntegrationsView> {
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.read_with(cx, |s, _| s.tools.integrations.clone())
}

fn into_babysit(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut VisualTestContext, Entity<IntegrationsView>) {
    let (workspace, cx) = open(cx, SettingsSectionId::Connections);
    let view = view(&workspace, cx);
    click(cx, &workspace, "babysit-prs-row");
    assert_eq!(view.read_with(cx, |v, _| v.page()), Page::BabysitPrs);
    (workspace, cx, view)
}

// ---- rules ----------------------------------------------------------------------------------------------------------

#[test]
fn defaults_match_the_shared_settings_and_bad_values_reset() {
    let d = Babysit::default();
    assert!(!d.enabled && d.interval_minutes == 1 && d.level == 3 && d.resolve_threads && d.stop_when_green);
    assert_eq!(d.wake, [Wake::Comments, Wake::Checks, Wake::Conflicts]);
    assert_eq!(d.stop_after_days, Rule { on: true, value: 7 });
    assert_eq!(d.stop_after_failures, Rule { on: false, value: 3 });
    let bad = Babysit {
        interval_minutes: 7,
        level: 9,
        wake: vec![Wake::Behind, Wake::Comments],
        stop_after_days: Rule { on: false, value: 2 },
        stop_after_failures: Rule { on: true, value: 4 },
        own_rule_text: "x".repeat(400),
        instructions: "y".repeat(5000),
        ..Babysit::default()
    }
    .normalized();
    assert_eq!((bad.interval_minutes, bad.level), (1, 3));
    assert_eq!(bad.wake, [Wake::Comments, Wake::Behind], "chips keep the settings' order");
    assert_eq!(bad.stop_after_days, Rule { on: false, value: 7 }, "the switch survives, the number resets");
    assert_eq!(bad.stop_after_failures, Rule { on: true, value: 3 });
    assert_eq!((bad.own_rule_text.len(), bad.instructions.len()), (OWN_RULE_MAX, INSTRUCTIONS_MAX));
    assert_eq!(LEVELS.len(), 5);
    assert_eq!(LEVELS[4].steps.len(), 4);
    assert_eq!(plural(1, "minute", "minutes"), "1 minute");
    assert_eq!(plural(5, "day", "days"), "5 days");
}

#[test]
fn the_linear_status_line_counts_workspaces() {
    let ws = |name: &str| LinearWorkspace { id: name.into(), organization: name.into(), viewer: "Victor".into(), can_write: true };
    assert_eq!(status_line(&[]), "Not connected");
    assert_eq!(status_line(&[ws("Acme")]), "Connected as Victor to Acme");
    assert_eq!(status_line(&[ws("A"), ws("B")]), "Connected to 2 workspaces");
}

// ---- Linear ---------------------------------------------------------------------------------------------------------

#[gpui::test]
fn linear_lists_its_workspaces_and_the_switch_hides_them(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Connections);
    let view = view(&workspace, cx);
    assert!(
        drawn(cx, "settings-section-connections") && drawn(cx, "linear-disconnect-happier-gym") && drawn(cx, "linear-disconnect-rdplus")
    );
    assert!(drawn(cx, "linear-move-to-started-check") && drawn(cx, "linear-connect"));
    click(cx, &workspace, "linear-enabled-check");
    assert!(!view.read_with(cx, |v, _| v.linear.enabled));
    assert!(!drawn(cx, "linear-disconnect-happier-gym") && !drawn(cx, "linear-connect"));
    click(cx, &workspace, "linear-enabled-check");
    assert!(drawn(cx, "linear-disconnect-happier-gym"));
}

#[gpui::test]
fn disconnecting_the_last_workspace_turns_the_row_into_connect(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Connections);
    let view = view(&workspace, cx);
    click(cx, &workspace, "linear-disconnect-rdplus");
    click(cx, &workspace, "linear-disconnect-happier-gym");
    assert!(view.read_with(cx, |v, _| v.linear.workspaces.is_empty()));
    assert!(!drawn(cx, "linear-move-to-started-check"), "nothing to move issues in");
    assert!(drawn(cx, "linear-connect"));
}

#[gpui::test]
fn connect_waits_for_the_sign_in_and_start_again_replaces_it(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Connections);
    let view = view(&workspace, cx);
    click(cx, &workspace, "linear-connect");
    assert_eq!(view.read_with(cx, |v, _| v.linear.connecting), Some(Connecting::Window), "another workspace signs in afresh");
    assert!(drawn(cx, "linear-use-browser"));
    // Use my browser instead: a new attempt that replaces the waiting one.
    advance(cx, CONNECT_MS / 2);
    click(cx, &workspace, "linear-use-browser");
    assert_eq!(view.read_with(cx, |v, _| v.linear.connecting), Some(Connecting::Browser));
    assert!(!drawn(cx, "linear-use-browser"));
    advance(cx, CONNECT_MS / 2 + 20);
    assert_eq!(view.read_with(cx, |v, _| v.linear.workspaces.len()), 2, "the replaced attempt adds nothing");
    advance(cx, CONNECT_MS);
    assert_eq!(view.read_with(cx, |v, _| v.linear.workspaces.len()), 3);
    assert_eq!(view.read_with(cx, |v, _| v.linear.connecting), None);
}

#[gpui::test]
fn a_failed_sign_in_shows_its_message_under_the_rows(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, SettingsSectionId::Connections);
    let view = view(&workspace, cx);
    view.update(cx, |v, _| v.linear.fail_next = Some("Linear refused the sign-in.".into()));
    click(cx, &workspace, "linear-connect");
    advance(cx, CONNECT_MS + 20);
    assert!(drawn(cx, "linear-error"));
    assert_eq!(view.read_with(cx, |v, _| v.linear.workspaces.len()), 2);
    click(cx, &workspace, "linear-connect");
    assert!(!drawn(cx, "linear-error"), "a new attempt clears it");
}

// ---- Babysit PRs ----------------------------------------------------------------------------------------------------

#[gpui::test]
fn the_row_says_on_or_off_and_opens_the_page_which_goes_back(cx: &mut TestAppContext) {
    let (workspace, cx, view) = into_babysit(cx);
    assert!(drawn(cx, "babysit-prs-page") && drawn(cx, "babysit-enabled-check") && drawn(cx, "babysit-reset"));
    click(cx, &workspace, "babysit-back");
    assert_eq!(view.read_with(cx, |v, _| v.page()), Page::Integrations);
    assert!(drawn(cx, "babysit-prs-row"));
}

#[gpui::test]
fn switches_chips_and_levels_save_at_once(cx: &mut TestAppContext) {
    let (workspace, cx, view) = into_babysit(cx);
    click(cx, &workspace, "babysit-enabled-check");
    assert!(view.read_with(cx, |v, _| v.babysit.settings.enabled), "the page answers before the host does");
    assert!(!view.read_with(cx, |v, _| v.babysit.host.saved.enabled));
    advance(cx, SAVE_MS + 10);
    assert!(view.read_with(cx, |v, _| v.babysit.host.saved.enabled));
    click(cx, &workspace, "babysit-wake-behind");
    click(cx, &workspace, "babysit-wake-comments");
    advance(cx, SAVE_MS + 10);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.host.saved.wake.clone()), [Wake::Checks, Wake::Conflicts, Wake::Behind]);
    click(cx, &workspace, "babysit-level-5");
    advance(cx, SAVE_MS + 10);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.host.saved.level), 5);
    click(cx, &workspace, "babysit-stop-failures");
    advance(cx, SAVE_MS + 10);
    assert!(view.read_with(cx, |v, _| v.babysit.host.saved.stop_after_failures.on));
    click(cx, &workspace, "babysit-stop-green");
    advance(cx, SAVE_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.babysit.host.saved.stop_when_green));
    // The "merged or closed" rule is always on and cannot be changed.
    click(cx, &workspace, "babysit-stop-closed");
    advance(cx, SAVE_MS + 10);
    assert!(drawn(cx, "babysit-stop-closed-row"));
}

#[gpui::test]
fn a_typed_rule_saves_after_typing_stops_and_shows_saved(cx: &mut TestAppContext) {
    let (workspace, cx, view) = into_babysit(cx);
    click(cx, &workspace, "babysit-stop-own");
    advance(cx, SAVE_MS + 10);
    let input = view.read_with(cx, |v, _| v.babysit.own_rule_input()).expect("the rule field exists");
    input.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    cx.simulate_input("stop when the label ship appears");
    settle(cx);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.field_state(Field::OwnRule)), SaveState::Idle, "typing takes the mark away");
    advance(cx, AUTOSAVE_MS - 100);
    assert_ne!(view.read_with(cx, |v, _| v.babysit.host.saved.own_rule_text.clone()), "stop when the label ship appears");
    advance(cx, 110);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.field_state(Field::OwnRule)), SaveState::Saving);
    advance(cx, SAVE_MS + 10);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.field_state(Field::OwnRule)), SaveState::Saved);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.host.saved.own_rule_text.clone()), "stop when the label ship appears");
}

#[gpui::test]
fn leaving_the_page_saves_what_was_typed_last(cx: &mut TestAppContext) {
    let (workspace, cx, view) = into_babysit(cx);
    let area = view.read_with(cx, |v, _| v.babysit.instructions_input()).expect("the instructions field exists");
    area.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    cx.simulate_input("Always reply in Portuguese.");
    settle(cx);
    click(cx, &workspace, "babysit-back");
    advance(cx, SAVE_MS + 10);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.host.saved.instructions.clone()), "Always reply in Portuguese.");
}

#[gpui::test]
fn a_failed_save_says_not_saved_and_the_page_returns_to_the_hosts_values(cx: &mut TestAppContext) {
    let (workspace, cx, view) = into_babysit(cx);
    view.update(cx, |v, _| v.babysit.host.fail = true);
    click(cx, &workspace, "babysit-level-1");
    advance(cx, SAVE_MS + 10);
    assert!(!view.read_with(cx, |v, _| v.babysit_error().is_empty()));
    assert_eq!(view.read_with(cx, |v, _| v.babysit.settings.level), 3, "back to what the host holds");
    let area = view.read_with(cx, |v, _| v.babysit.instructions_input()).unwrap();
    area.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    cx.simulate_input("x");
    advance(cx, AUTOSAVE_MS + SAVE_MS + 20);
    assert_eq!(view.read_with(cx, |v, _| v.babysit.field_state(Field::Instructions)), SaveState::Error);
    assert!(drawn(cx, "babysit-not-saved"));
}

#[gpui::test]
fn reset_all_puts_every_default_back_and_empties_the_fields(cx: &mut TestAppContext) {
    let (workspace, cx, view) = into_babysit(cx);
    click(cx, &workspace, "babysit-enabled-check");
    click(cx, &workspace, "babysit-level-5");
    let area = view.read_with(cx, |v, _| v.babysit.instructions_input()).unwrap();
    area.update_in(cx, |state, window, cx| state.focus(window, cx));
    settle(cx);
    cx.simulate_input("typed");
    settle(cx);
    click(cx, &workspace, "babysit-reset");
    advance(cx, AUTOSAVE_MS + SAVE_MS + 20);
    let (settings, saved) = view.read_with(cx, |v, _| (v.babysit.settings.clone(), v.babysit.host.saved.clone()));
    assert_eq!(settings, Babysit::default());
    assert_eq!(saved, Babysit::default());
    assert_eq!(cx.update(|_, app| area.read(app).value().to_string()), "");
    assert_eq!(view.read_with(cx, |v, _| v.babysit.field_state(Field::Instructions)), SaveState::Idle);
}

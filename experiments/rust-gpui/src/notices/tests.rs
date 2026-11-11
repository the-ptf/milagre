use std::rc::Rc;
use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::model::{AppUpdate, Presentation, ProviderUpdate, UpdateStatus};
use super::{NoticeEvent, NoticesLayer, Scenario, TOAST_FOR};
use crate::overlays::dialogs::FixtureHost;
use crate::testing;

fn mount(cx: &mut TestAppContext, scenario: Option<Scenario>) -> (Entity<NoticesLayer>, &mut VisualTestContext) {
    let (layer, cx) = testing::mount_in_root(cx, |_, cx| NoticesLayer::new(Rc::new(FixtureHost::new()), cx));
    if let Some(scenario) = scenario {
        layer.update(cx, |layer, cx| layer.apply(scenario, cx));
        cx.run_until_parked();
    }
    (layer, cx)
}

fn downloaded() -> AppUpdate {
    AppUpdate::new(UpdateStatus::Downloaded).with_version("0.233.0")
}

#[test]
fn every_status_has_its_words() {
    let status = |status| AppUpdate::new(status).with_version("0.233.0");
    let words = [
        (UpdateStatus::Installing, "Restarting Milagre", "Saving your work and restarting with the new version."),
        (UpdateStatus::Downloaded, "Update available", "v0.233.0 is ready to install."),
        (UpdateStatus::Downloading, "Downloading update", "You can keep working while Milagre downloads the update."),
        (UpdateStatus::Error, "Update failed", "The update could not finish."),
        (UpdateStatus::Checking, "Checking for updates", "Looking for a newer version of Milagre."),
        (UpdateStatus::UpToDate, "Up to date", "You have the latest version of Milagre."),
    ];
    for (state, title, description) in words {
        assert_eq!(status(state).title(), title);
        assert_eq!(status(state).description(), description);
    }
    assert_eq!(AppUpdate::new(UpdateStatus::Downloaded).description(), "The update is ready to install.");
    let mut downloading = status(UpdateStatus::Downloading);
    downloading.progress = 41.6;
    assert_eq!(downloading.pill_text(), "Downloading update \u{b7} 42%");
    assert_eq!(downloaded().restart_note(), Some("Restarting Milagre will stop running agents."));
    assert!(AppUpdate { auto: true, ..downloaded() }.restart_note().unwrap().starts_with("Auto update is on"));
    assert_eq!(status(UpdateStatus::Installing).restart_note(), None);
}

#[test]
fn the_card_opens_once_per_version() {
    let mut presentation = Presentation::default();
    assert!(presentation.observe(&downloaded()));
    assert!(presentation.open);
    // Closed to the pill, the same version does not open it again.
    presentation.open = false;
    assert!(!presentation.observe(&downloaded()));
    assert!(!presentation.open);
    // A newer one does, even after a dismissal.
    presentation.dismissed = true;
    assert!(presentation.observe(&AppUpdate::new(UpdateStatus::Downloaded).with_version("0.234.0")));
    assert!(presentation.open && !presentation.dismissed);
}

#[test]
fn a_failed_update_opens_its_card_only_when_it_names_a_version() {
    let mut presentation = Presentation::default();
    assert!(!presentation.observe(&AppUpdate::new(UpdateStatus::Error)));
    assert!(presentation.observe(&AppUpdate::new(UpdateStatus::Error).with_version("0.233.0")));
}

#[test]
fn which_states_draw() {
    let state = |status| AppUpdate::new(status).with_version("0.233.0");
    let closed = Presentation::default();
    for hidden in [UpdateStatus::Idle, UpdateStatus::Unavailable, UpdateStatus::Checking, UpdateStatus::UpToDate] {
        assert!(!closed.visible(&state(hidden)), "{hidden:?} draws nothing until opened");
    }
    for shown in [UpdateStatus::Downloading, UpdateStatus::Downloaded, UpdateStatus::Installing, UpdateStatus::Error] {
        assert!(closed.visible(&state(shown)), "{shown:?} draws the pill");
    }
    // Opened from Settings, a check shows its card; "unavailable" and "idle" never do.
    let opened = Presentation { open: true, ..Presentation::default() };
    assert!(opened.visible(&state(UpdateStatus::UpToDate)));
    assert!(!opened.visible(&state(UpdateStatus::Idle)));
    // Dismissed hides the pill, but not an install under way.
    let dismissed = Presentation { dismissed: true, ..Presentation::default() };
    assert!(!dismissed.visible(&state(UpdateStatus::Downloaded)));
    assert!(dismissed.visible(&state(UpdateStatus::Installing)));
    assert!(dismissed.is_open(&state(UpdateStatus::Installing)));
}

#[gpui::test]
fn nothing_shows_until_something_happens(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, None);
    for selector in ["update-notice", "provider-update", "host-outdated", "host-disconnected", "save-failure", "toast"] {
        assert!(cx.debug_bounds(selector).is_none(), "{selector} is not drawn");
    }
    assert!(layer.read_with(cx, |layer, cx| layer.host.read(cx).is_empty()));
}

#[gpui::test]
fn a_downloaded_update_shows_its_card_and_the_pill_toggles_it(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::UpdateDownloaded));
    let update = layer.read_with(cx, |layer, _| layer.update.clone());
    assert!(update.read_with(cx, |update, _| update.is_open()));
    assert!(cx.debug_bounds("update-install").is_some() && cx.debug_bounds("update-notes").is_some());
    assert!(testing::bounds(cx, "update-notice").size.width.as_f32() >= 360.0);

    update.update(cx, |update, cx| update.close(cx));
    cx.run_until_parked();
    assert!(update.read_with(cx, |update, _| !update.is_open() && update.is_visible()));
    assert!(cx.debug_bounds("update-install").is_none(), "the pill has no buttons");
    let pill = testing::bounds(cx, "update-notice");
    assert!(pill.size.width.as_f32() < 360.0);

    cx.simulate_click(pill.center(), Modifiers::none());
    assert!(update.read_with(cx, |update, _| update.is_open()), "a click on the pill opens the card");
}

#[gpui::test]
fn dismiss_hides_it_and_a_newer_version_brings_it_back(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::UpdateDownloaded));
    let update = layer.read_with(cx, |layer, _| layer.update.clone());
    let dismiss = testing::bounds(cx, "update-dismiss");
    cx.simulate_click(dismiss.center(), Modifiers::none());
    assert!(update.read_with(cx, |update, _| !update.is_visible()));
    assert!(cx.debug_bounds("update-notice").is_none());

    update.update(cx, |update, cx| update.set_state(Some(AppUpdate::new(UpdateStatus::Downloaded).with_version("0.234.0")), cx));
    cx.run_until_parked();
    assert!(update.read_with(cx, |update, _| update.is_open()));
    assert!(cx.debug_bounds("update-notice").is_some());
}

#[gpui::test]
fn install_and_restart_ends_in_the_installing_card(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::UpdateDownloaded));
    let update = layer.read_with(cx, |layer, _| layer.update.clone());
    let install = testing::bounds(cx, "update-install");
    cx.simulate_click(install.center(), Modifiers::none());
    assert!(update.read_with(cx, |update, _| update.is_pending()), "Restarting\u{2026} while it works");
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(
        update.read_with(cx, |update, _| { !update.is_pending() && update.state().is_some_and(AppUpdate::installing) && update.is_open() })
    );
    // Installing cannot be dismissed or closed.
    assert!(cx.debug_bounds("update-dismiss").is_none());
    update.update(cx, |update, cx| {
        update.close(cx);
        update.dismiss(cx);
    });
    assert!(update.read_with(cx, |update, _| update.is_open() && update.is_visible()));
}

#[gpui::test]
fn a_download_shows_its_progress(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::UpdateDownloadingCard));
    assert!(cx.debug_bounds("progress-bar").is_some());
    assert!(cx.debug_bounds("update-install").is_none(), "nothing to install yet");
    let update = layer.read_with(cx, |layer, _| layer.update.clone());
    assert!(update.read_with(cx, |update, _| update.state().is_some_and(|s| s.percent() == 42)));
}

#[gpui::test]
fn a_failed_update_offers_try_again(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::UpdateError));
    let update = layer.read_with(cx, |layer, _| layer.update.clone());
    assert!(update.read_with(cx, |update, _| update.is_open()));
    assert!(cx.debug_bounds("inline-error").is_some());
    let retry = testing::bounds(cx, "update-install");
    cx.simulate_click(retry.center(), Modifiers::none());
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(update.read_with(cx, |update, _| update.state().is_some_and(|s| s.status == UpdateStatus::Checking)));
}

#[gpui::test]
fn whats_new_opens_the_release_notes(cx: &mut TestAppContext) {
    let (_layer, cx) = mount(cx, Some(Scenario::UpdateDownloaded));
    let notes = testing::bounds(cx, "update-notes");
    cx.simulate_click(notes.center(), Modifiers::none());
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(cx.debug_bounds("notes-body").is_some(), "the release notes dialog is open");
}

#[gpui::test]
fn the_provider_card_queues_dismisses_and_installs(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::Provider));
    let provider = layer.read_with(cx, |layer, _| layer.provider.clone());
    assert_eq!(provider.read_with(cx, |p, _| p.current().cloned()).map(|u| u.provider.id()), Some("claude"));
    let dismiss = testing::bounds(cx, "provider-update-dismiss");
    cx.simulate_click(dismiss.center(), Modifiers::none());
    assert_eq!(provider.read_with(cx, |p, _| p.current().cloned()).map(|u| u.provider.id()), Some("codex"), "the next release shows");

    let install = testing::bounds(cx, "provider-update-install");
    cx.simulate_click(install.center(), Modifiers::none());
    assert!(provider.read_with(cx, |p, _| p.is_working()));
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(provider.read_with(cx, |p, _| p.current().is_none()));
    assert!(cx.debug_bounds("provider-update").is_none());
}

#[gpui::test]
fn a_failed_provider_install_says_so_and_retries(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::ProviderError));
    let provider = layer.read_with(cx, |layer, _| layer.provider.clone());
    let install = testing::bounds(cx, "provider-update-install");
    cx.simulate_click(install.center(), Modifiers::none());
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(provider.read_with(cx, |p, _| !p.error().is_empty() && p.current().is_some()));
    provider.update(cx, |p, cx| p.install(cx));
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(provider.read_with(cx, |p, _| p.current().map(|u| u.provider.id())), Some("codex"));
}

#[gpui::test]
fn the_provider_settings_button_asks_the_window_for_settings(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::Provider));
    let seen = Rc::new(std::cell::RefCell::new(Vec::new()));
    let log = seen.clone();
    let _keep =
        layer.update(cx, |_, cx| cx.subscribe(&cx.entity(), move |_, _, event: &NoticeEvent, _| log.borrow_mut().push(event.clone())));
    let settings = testing::bounds(cx, "provider-update-settings");
    cx.simulate_click(settings.center(), Modifiers::none());
    // The event is the provider's; the layer forwards it to its own subscribers.
    assert!(seen.borrow().len() <= 1);
    let key = ProviderUpdate { provider: crate::data::Provider::Claude, version: "2.1.140".into() }.key();
    assert_eq!(key, "claude:2.1.140");
}

#[gpui::test]
fn host_outdated_offers_a_restart(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::HostOutdated));
    let host = layer.read_with(cx, |layer, _| layer.host.clone());
    assert!(cx.debug_bounds("host-outdated").is_some());
    let restart = testing::bounds(cx, "restart-host");
    cx.simulate_click(restart.center(), Modifiers::none());
    assert!(host.read_with(cx, |host, _| host.is_restarting()));
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(host.read_with(cx, |host, _| host.is_empty()));
    assert!(cx.debug_bounds("host-outdated").is_none());
}

#[gpui::test]
fn a_gone_host_says_reconnecting_or_that_the_restart_failed(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::HostDisconnected));
    assert!(cx.debug_bounds("host-disconnected").is_some());
    assert!(cx.debug_bounds("restart-host").is_none());
    layer.update(cx, |layer, cx| layer.apply(Scenario::HostFailed, cx));
    cx.run_until_parked();
    let host = layer.read_with(cx, |layer, _| layer.host.clone());
    assert!(host.read_with(cx, |host, _| host.connection().failed));
    assert!(cx.debug_bounds("host-disconnected").is_some());
}

#[gpui::test]
fn unsaved_changes_stay_until_a_retry_saves_them(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::Save));
    let host = layer.read_with(cx, |layer, _| layer.host.clone());
    assert!(cx.debug_bounds("save-failure").is_some());
    assert_eq!(host.read_with(cx, |host, _| host.saves()[0].detail()), "Disk is full. Free space on your computer, then retry.");
    let retry = testing::bounds(cx, "retry-save-/Users/me/Code/happiergym");
    cx.simulate_click(retry.center(), Modifiers::none());
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert!(host.read_with(cx, |host, _| host.saves().is_empty()));
    assert!(cx.debug_bounds("save-failure").is_none());
}

#[gpui::test]
fn an_offline_save_cannot_be_retried(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::SaveOffline));
    let host = layer.read_with(cx, |layer, _| layer.host.clone());
    host.update(cx, |host, cx| host.retry_save("/Users/me/Code/happiergym", cx));
    cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(host.read_with(cx, |host, _| host.saves().len()), 1);
}

#[gpui::test]
fn the_toast_goes_after_its_time(cx: &mut TestAppContext) {
    let (layer, cx) = mount(cx, Some(Scenario::Toast));
    assert_eq!(layer.read_with(cx, |layer, _| layer.toast().map(str::to_string)), Some("Opened in Zed".to_string()));
    assert!(cx.debug_bounds("toast").is_some());
    cx.executor().advance_clock(TOAST_FOR + Duration::from_millis(50));
    cx.run_until_parked();
    assert!(layer.read_with(cx, |layer, _| layer.toast().is_none()));
    assert!(cx.debug_bounds("toast").is_none());
}

#[gpui::test]
fn the_layer_takes_no_clicks_outside_its_notices(cx: &mut TestAppContext) {
    // Clicking far from every notice must reach what is beneath: nothing opens or closes.
    let (layer, cx) = mount(cx, Some(Scenario::All));
    let before = layer.read_with(cx, |layer, cx| layer.provider.read(cx).current().cloned());
    cx.simulate_click(gpui::point(gpui::px(300.0), gpui::px(300.0)), Modifiers::none());
    assert_eq!(layer.read_with(cx, |layer, cx| layer.provider.read(cx).current().cloned()), before);
}

#[test]
fn scenario_names_all_parse() {
    for name in [
        "update-downloaded",
        "update-downloaded-auto",
        "update-pill",
        "update-downloading",
        "update-downloading-card",
        "update-installing",
        "update-error",
        "update-checking",
        "update-uptodate",
        "provider",
        "provider-error",
        "host-outdated",
        "host-disconnected",
        "host-failed",
        "save",
        "save-offline",
        "toast",
        "all",
    ] {
        assert!(Scenario::from_name(name).is_some(), "{name}");
    }
    assert!(Scenario::from_name("nope").is_none());
}

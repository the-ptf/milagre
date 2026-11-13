//! Headless tests for WP-44 (Devices half): Phone & sharing, This Mac with its resources and the cleanup dialog,
//! Computer pages, Computer use and Worktrees. The rules are tested beside their code (`logic.rs`, `qr.rs`).

use std::time::Duration;

use gpui::{Entity, Modifiers, TestAppContext, VisualTestContext};

use super::logic::{DeviceKind, PhoneState};
use super::model::DevicesStore;
use crate::settings::search::SettingsSectionId;
use crate::settings::{SelectedSection, SettingsModal};
use crate::testing;
use crate::workspace::Workspace;

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(testing::leak(selector.to_string())).is_some()
}

fn click(cx: &mut VisualTestContext, workspace: &Entity<Workspace>, selector: &str) {
    let body = cx.debug_bounds("settings-main").expect("settings body");
    let at = cx.debug_bounds(testing::leak(selector.to_string())).unwrap_or_else(|| panic!("`{selector}` is not drawn"));
    let overshoot = f32::from(at.bottom() - body.bottom()) + 80.0;
    if overshoot > 0.0 {
        let settings = workspace.read_with(cx, |w, _| w.settings.clone());
        let handle = settings.read_with(cx, |s, _| s.body_scroll().clone());
        let current = handle.offset();
        handle.set_offset(gpui::point(current.x, current.y - gpui::px(overshoot)));
        settle(cx);
    }
    let at = cx.debug_bounds(testing::leak(selector.to_string())).expect("still drawn").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

fn open(cx: &mut TestAppContext, section: SelectedSection) -> (Entity<Workspace>, &mut VisualTestContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| {
        s.open(window, cx);
        s.select_section(section, cx);
    });
    settle(cx);
    (workspace, cx)
}

fn store(cx: &mut VisualTestContext) -> DevicesStore {
    cx.update(|_, cx| cx.global::<DevicesStore>().clone())
}

fn advance(cx: &mut VisualTestContext, ms: u64) {
    cx.executor().advance_clock(Duration::from_millis(ms));
    settle(cx);
}

fn section(id: SettingsSectionId) -> SelectedSection {
    SelectedSection::Section(id)
}

#[gpui::test]
fn the_phone_page_shows_the_code_and_turning_access_off_takes_it_away(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::Devices));
    assert!(drawn(cx, "settings-section-devices") && drawn(cx, "phone-qr-block") && drawn(cx, "phone-pairing-open"));
    assert!(drawn(cx, "device-row-p1") && drawn(cx, "device-new"), "phones list, the iPad is marked New");
    click(cx, &workspace, "devices-allow-check-box");
    assert_eq!(store(cx).phone.state, PhoneState::Off);
    assert!(!drawn(cx, "phone-qr-block") && !drawn(cx, "devices-lan-check-box"));
    click(cx, &workspace, "devices-allow-check-box");
    assert_eq!(store(cx).phone.state, PhoneState::On);
    assert!(drawn(cx, "phone-qr-block"));
}

#[gpui::test]
fn removing_a_device_takes_two_clicks(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::Devices));
    click(cx, &workspace, "device-remove-p3");
    assert!(drawn(cx, "device-confirm-p3") && store(cx).devices.iter().any(|d| d.key == "p3"));
    click(cx, &workspace, "device-cancel-p3");
    assert!(drawn(cx, "device-remove-p3"));
    click(cx, &workspace, "device-remove-p3");
    click(cx, &workspace, "device-confirm-p3");
    assert!(!store(cx).devices.iter().any(|d| d.key == "p3"));
    assert!(store(cx).devices.iter().any(|d| d.kind == DeviceKind::Phone));
}

#[gpui::test]
fn reset_access_asks_first_then_forgets_every_device(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::Devices));
    let before = store(cx).phone.pairing_link;
    click(cx, &workspace, "devices-reset");
    assert!(drawn(cx, "devices-reset-confirm") && !store(cx).devices.is_empty());
    click(cx, &workspace, "devices-reset-confirm");
    let after = store(cx);
    assert!(after.devices.is_empty());
    assert_ne!(after.phone.pairing_link, before, "a new code");
    assert!(drawn(cx, "devices-empty"));
}

#[gpui::test]
fn a_resource_row_opens_its_breakdown_and_the_cleanup_dialog_removes_with_progress(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::ThisMac));
    assert!(drawn(cx, "resources-this-mac") && !drawn(cx, "resource-breakdown"));
    click(cx, &workspace, "resource-toggle-this-mac");
    assert!(drawn(cx, "resource-breakdown") && drawn(cx, "resource-parts-disk"));
    click(cx, &workspace, "resource-toggle-this-mac");
    assert!(!drawn(cx, "resource-breakdown"));
    click(cx, &workspace, "resource-toggle-this-mac");

    let idle_before = store(cx).idle.len();
    click(cx, &workspace, "resource-cleanup-this-mac");
    assert!(drawn(cx, "worktree-cleanup"), "the dialog opens");
    assert!(drawn(cx, "cleanup-group-saved") && drawn(cx, "cleanup-row-fix-onboarding-hang"));
    // Only what is safe is checked at first.
    let selected = cx.update(|_, cx| cx.global::<super::cleanup::CleanupState>().selected.len());
    assert_eq!(selected, 3);
    // 90 days narrows the list and the selection with it.
    click(cx, &workspace, "cleanup-days-90");
    assert!(!drawn(cx, "cleanup-row-fix-onboarding-hang") && drawn(cx, "cleanup-row-release-notes-draft"));
    click(cx, &workspace, "cleanup-remove");
    assert!(drawn(cx, "cleanup-removing") && drawn(cx, "cleanup-stop"));
    advance(cx, 700);
    assert_eq!(store(cx).idle.len(), idle_before - 1);
    assert!(!drawn(cx, "worktree-cleanup"), "the dialog closes when it is done");
    assert_eq!(store(cx).last_toast.as_deref(), Some("Removed 1 worktree."));
}

#[gpui::test]
fn stop_ends_the_cleanup_before_the_next_worktree(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::Worktrees));
    let idle_before = store(cx).idle.len();
    click(cx, &workspace, "worktrees-cleanup");
    click(cx, &workspace, "cleanup-remove");
    advance(cx, 350);
    click(cx, &workspace, "cleanup-stop");
    advance(cx, 1000);
    let after = store(cx);
    assert_eq!(after.idle.len(), idle_before - 1);
    assert_eq!(after.last_toast.as_deref(), Some("Removed 1 worktree. Stopped before the rest."));
}

#[gpui::test]
fn the_worktrees_page_keeps_the_main_sync_default(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::Worktrees));
    assert!(!store(cx).main_sync_default);
    click(cx, &workspace, "worktrees-main-sync-check-box");
    assert!(store(cx).main_sync_default);
}

fn computer_section(cx: &mut TestAppContext, id: &str, name: &str) -> SelectedSection {
    let _ = cx;
    SelectedSection::Computer { id: id.into(), name: name.into(), connected: true }
}

#[gpui::test]
fn a_computer_page_checks_for_updates_and_removes_after_a_second_click(cx: &mut TestAppContext) {
    let id = "deer-studio";
    let selected = computer_section(cx, id, "deer");
    let (workspace, cx) = open(cx, selected);
    assert!(drawn(cx, "settings-section-computer-deer-studio") && drawn(cx, "computer-update") && drawn(cx, "computer-auto-update"));
    assert!(drawn(cx, "resource-breakdown"), "its own memory and disk are open");
    // Downloaded: Install asks, Cancel puts the button back.
    click(cx, &workspace, "computer-update-install");
    assert!(drawn(cx, "computer-update-confirm"));
    click(cx, &workspace, "computer-update-cancel");
    assert!(drawn(cx, "computer-update-install"));
    // Hide it from the sidebar.
    click(cx, &workspace, "computer-show-check-box");
    assert!(store(cx).hidden_computers.contains(id));
    click(cx, &workspace, "computer-auto-update-check-box");
    assert!(store(cx).meta[id].auto_update);
    click(cx, &workspace, "computer-remove");
    assert!(store(cx).computer(id).is_some());
    click(cx, &workspace, "computer-remove-confirm");
    assert!(store(cx).computer(id).is_none());
    assert!(!store(cx).hidden_computers.contains(id), "a computer paired again comes back shown");
}

#[gpui::test]
fn an_offline_computer_says_when_it_was_seen_and_hides_what_it_cannot_answer(cx: &mut TestAppContext) {
    let selected = computer_section(cx, "tianxu-mini", "tianxu");
    let (_workspace, cx) = open(cx, selected);
    assert!(drawn(cx, "computer-projects") && !drawn(cx, "computer-update") && !drawn(cx, "computer-auto-update"));
}

#[gpui::test]
fn computer_use_opens_from_this_mac_and_grant_fixes_a_missing_permission(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::ThisMac));
    click(cx, &workspace, "computer-use-row");
    assert!(drawn(cx, "computer-use-page") && drawn(cx, "cu-permission-screen-recording") && drawn(cx, "cu-grant-screen-recording"));
    click(cx, &workspace, "cu-grant-screen-recording");
    assert!(!drawn(cx, "cu-grant-screen-recording"));
    click(cx, &workspace, "cu-enabled-check-box");
    assert!(!store(cx).computer_use.enabled && !drawn(cx, "cu-permission-accessibility"));
    click(cx, &workspace, "computer-use-back");
    assert!(drawn(cx, "this-mac-settings"));
}

#[gpui::test]
fn dropping_other_computers_leaves_only_this_mac_in_the_list(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::ThisMac));
    assert!(drawn(cx, "resources-deer-studio") && drawn(cx, "mac-add-computer"));
    click(cx, &workspace, "mac-drive-other-check-box");
    assert!(!drawn(cx, "resources-deer-studio") && !drawn(cx, "mac-add-computer"));
}

#[gpui::test]
fn simlock_saves_its_gateway_and_clears_the_token_field(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, section(SettingsSectionId::Devices));
    assert!(drawn(cx, "simlock-save"));
    click(cx, &workspace, "simlock-save");
    let settings: Entity<SettingsModal> = workspace.read_with(cx, |w, _| w.settings.clone());
    let view = settings.read_with(cx, |s, _| s.devices.clone());
    assert!(
        view.read_with(cx, |v, _| v.simlock_check.clone())
            .is_some_and(|(ok, text)| ok && text.starts_with("Connected to http://127.0.0.1:4700"))
    );
}

#[test]
fn a_hosts_phone_status_devices_and_resources_read_as_the_pages_show_them() {
    use super::hosted::{paired_devices, phone_status, resources};
    use super::logic::{PartKind, Remote, Route, phone_status_line};
    let (status, pairing) = phone_status(&serde_json::json!({"enabled": true, "state": "on", "remote": "relay", "relay": "online",
        "pairingUntil": 1_700_000_000_000.0, "pairingLink": "https://relay/pair#k=1", "computerLink": "https://relay/pair#k=1&c",
        "qrSvg": "<svg/>", "pairingOptions": [{"id": "automatic", "label": "Automatic", "link": "https://a", "qrSvg": "<svg a/>"},
            {"id": "relay", "label": "Remote relay", "link": "https://r"}],
        "lan": {"enabled": true, "addresses": ["10.0.0.2"]}, "localUrl": "http://127.0.0.1:8787/x"}));
    assert_eq!((status.state, status.remote, status.pairing_until), (PhoneState::On, Remote::Relay, Some(1_700_000_000_000)));
    assert_eq!(phone_status_line(Some(&status)), "On, reachable from any network");
    assert_eq!(status.pairing_options.len(), 2);
    assert_eq!(pairing.chosen("automatic"), (Some("<svg a/>"), Some("https://a")));
    assert_eq!(pairing.chosen("relay"), (Some("<svg/>"), Some("https://r")), "an option without its own code shows the status's");
    assert_eq!(pairing.chosen("gone"), (Some("<svg a/>"), Some("https://a")), "a choice no longer offered falls to the first");
    // Off: no code to scan.
    let (off, pairing) =
        phone_status(&serde_json::json!({"enabled": false, "state": "off", "remote": "none", "localUrl": "http://127.0.0.1:9/"}));
    assert!(off.pairing_link.is_empty() && pairing.chosen("automatic") == (None, None));
    assert_eq!(off.local_host, "127.0.0.1");
    let (tunnel, _) = phone_status(
        &serde_json::json!({"enabled": true, "state": "on", "remote": "cloudflare", "publicUrl": "https://mac.example.com:8443/p"}),
    );
    assert_eq!(phone_status_line(Some(&tunnel)), "Reachable at mac.example.com:8443");

    let devices =
        paired_devices(&serde_json::json!([{"key": "p1", "kind": "phone", "name": null, "lastSeen": 5.0, "isNew": true, "route": "lan"},
        {"key": "c1", "kind": "computer", "name": "mini", "lastSeen": null, "route": null}]));
    assert_eq!(
        devices.iter().map(|d| (d.key.as_str(), d.kind, d.route, d.is_new)).collect::<Vec<_>>(),
        [("p1", DeviceKind::Phone, Some(Route::Lan), true), ("c1", DeviceKind::Computer, None, false)]
    );

    let read = resources(&serde_json::json!({"memory": {"total": 8.0, "available": 2.0, "milagre": null},
        "disk": {"total": 10.0, "available": 4.0, "milagre": 1.0, "parts": [{"kind": "speech", "bytes": 1.0, "count": 0}], "measuring": true}})).unwrap();
    assert!(read.memory.parts.is_empty() && read.memory.milagre.is_none());
    let disk = read.disk.unwrap();
    assert!(disk.measuring && disk.parts[0].kind == PartKind::Data);
    assert!(resources(&serde_json::json!({"memory": {}})).is_none());
}

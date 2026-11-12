//! Headless tests for WP-39: Settings dialog shell, search index/ranker, nav selection, and each simple
//! section's controls (`general`, `chat`, `notifications`, `models`, `browser`, `experimental`, `about`).

use gpui::{Modifiers, TestAppContext, VisualTestContext, point, px};

use super::ToggleSettings;
use super::search::{
    ALL_SECTIONS, SETTINGS_INDEX, SettingsSectionId, build_search_entries, fold_search_text, search_ranges, search_settings, search_trail,
};
use super::store::{
    ChatListMode, ClaudeReplyStyle, CompactButtonDisplay, EditorChoice, FollowUpMode, OpenLinksIn, PermissionMode, ReleaseChannel,
    SettingsStore, ToolCallDisplay, UsageDisplayMode,
};
use crate::logic::lists::order::ChatOrder;
use crate::testing;

fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    crate::fitcheck::harness::draw(cx);
    crate::fitcheck::harness::draw(cx);
}

fn bounds(cx: &mut VisualTestContext, selector: &'static str) -> gpui::Bounds<gpui::Pixels> {
    cx.debug_bounds(selector).unwrap_or_else(|| panic!("`{selector}` is not drawn"))
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let at = bounds(cx, selector).center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

#[gpui::test]
fn settings_search_folds_accents_ranks_hits_and_builds_trails() {
    assert_eq!(fold_search_text("Notificações"), "notificacoes");
    assert_eq!(search_ranges("Notification chime", "chime"), vec![(13, 18)]);

    let entries = build_search_entries(
        Some("Victor's MacBook Pro"),
        &[("santo".to_string(), "Santo".to_string(), true)],
        &[("/Users/victor/Code/milagre".to_string(), "milagre".to_string())],
    );
    assert!(entries.len() > ALL_SECTIONS.len() + SETTINGS_INDEX.len());

    let hits = search_settings(&entries, "keep awake", 10);
    assert!(!hits.is_empty(), "finds Keep the Mac awake");
    assert_eq!(hits[0].entry.page, SettingsSectionId::General);
    assert_eq!(hits[0].entry.title, "Keep the Mac awake");
    assert_eq!(search_trail(&hits[0].entry), "General › System");

    let fatality = search_settings(&entries, "mortal kombat", 10);
    assert!(!fatality.is_empty());
    assert_eq!(fatality[0].entry.page, SettingsSectionId::Experimental);
    assert_eq!(fatality[0].entry.title, "Ultracode Fatality");
    assert_eq!(search_trail(&fatality[0].entry), "Church › Beta");
}

#[gpui::test]
fn settings_opens_with_cmd_comma_and_closes_on_escape_button_or_scrim(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    settle(cx);

    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    assert!(!settings.read_with(cx, |s, _| s.is_open()));
    assert!(cx.debug_bounds("settings-dialog").is_none());

    // Open with cmd-, (dispatches ToggleSettings).
    cx.update(|window, cx| window.dispatch_action(Box::new(ToggleSettings), cx));
    settle(cx);
    assert!(settings.read_with(cx, |s, _| s.is_open()));
    let dialog = bounds(cx, "settings-dialog");
    assert_eq!(dialog.size.width, px(1120.0));
    assert_eq!(dialog.size.height, px(800.0));
    assert_eq!(bounds(cx, "settings-nav").size.width, px(248.0));

    // Escape closes Settings when search is empty.
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(!settings.read_with(cx, |s, _| s.is_open()));
    assert!(cx.debug_bounds("settings-dialog").is_none());

    // Clicking the sidebar footer Settings icon opens it; clicking the close button closes it.
    click(cx, "sidebar-settings");
    assert!(settings.read_with(cx, |s, _| s.is_open()));
    click(cx, "settings-close");
    assert!(!settings.read_with(cx, |s, _| s.is_open()));

    // Clicking the scrim outside the modal card closes it.
    click(cx, "sidebar-settings");
    assert!(settings.read_with(cx, |s, _| s.is_open()));
    cx.simulate_mouse_down(point(px(10.0), px(10.0)), gpui::MouseButton::Left, Modifiers::none());
    settle(cx);
    assert!(!settings.read_with(cx, |s, _| s.is_open()));
}

#[gpui::test]
fn settings_nav_switches_between_simple_sections_and_placeholders(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open(window, cx));
    settle(cx);

    assert_eq!(settings.read_with(cx, |s, _| s.selected_section_id()), SettingsSectionId::General);
    assert!(cx.debug_bounds("settings-section-general").is_some());

    // Appearance draws its full page (WP-40).
    click(cx, "settings-nav-appearance");
    assert_eq!(settings.read_with(cx, |s, _| s.selected_section_id()), SettingsSectionId::Appearance);
    assert!(cx.debug_bounds("settings-section-appearance").is_some());
    assert!(cx.debug_bounds("settings-placeholder-WP-40").is_none());

    // Keybindings is a page.
    click(cx, "settings-nav-keybindings");
    assert!(cx.debug_bounds("settings-section-keybindings").is_some());
    assert!(cx.debug_bounds("settings-placeholder-WP-41").is_none());

    // Accounts and Usage are WP-42 pages.
    click(cx, "settings-nav-accounts");
    assert!(cx.debug_bounds("settings-section-accounts").is_some());
    assert!(cx.debug_bounds("settings-placeholder-WP-42").is_none());

    // MCP is a WP-43 page.
    click(cx, "settings-nav-mcp");
    assert!(cx.debug_bounds("settings-section-mcp").is_some());
    assert!(cx.debug_bounds("settings-placeholder-WP-43").is_none());

    // Simple sections draw their full bodies.
    for (nav_sel, sec_sel, expected) in [
        ("settings-nav-chat", "settings-section-chat", SettingsSectionId::Chat),
        ("settings-nav-notifications", "settings-section-notifications", SettingsSectionId::Notifications),
        ("settings-nav-models", "settings-section-models", SettingsSectionId::Models),
        ("settings-nav-browser", "settings-section-browser", SettingsSectionId::Browser),
    ] {
        click(cx, nav_sel);
        assert_eq!(settings.read_with(cx, |s, _| s.selected_section_id()), expected);
        assert!(cx.debug_bounds(sec_sel).is_some());
    }

    // Open Church and About via open_section (below the nav scroll fold when many projects exist).
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Experimental, window, cx));
    settle(cx);
    assert!(cx.debug_bounds("settings-section-experimental").is_some());

    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::About, window, cx));
    settle(cx);
    assert!(cx.debug_bounds("settings-section-about").is_some());
}

#[gpui::test]
fn settings_search_focuses_on_cmd_f_jumps_to_hit_and_highlights_row(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open(window, cx));
    settle(cx);

    // cmd-f focuses the search input; typing filters results.
    cx.simulate_keystrokes("cmd-f");
    settle(cx);
    cx.simulate_input("fatality");
    settle(cx);

    assert!(cx.debug_bounds("settings-search-results").is_some());
    assert!(cx.debug_bounds("settings-search-hit-experimental-ultracode-fatality").is_some());

    // Clicking the hit switches to Church and lights up the Ultracode Fatality row.
    click(cx, "settings-search-hit-experimental-ultracode-fatality");
    assert_eq!(settings.read_with(cx, |s, _| s.selected_section_id()), SettingsSectionId::Experimental);
    assert_eq!(settings.read_with(cx, |s, _| s.highlighted_row().map(str::to_owned)), Some("Ultracode Fatality".to_string()));
    assert!(cx.debug_bounds("settings-found-row").is_some());

    // Escape first clears the search query while keeping Settings open; a second Escape closes Settings.
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(settings.read_with(cx, |s, _| s.is_open()));
    assert_eq!(settings.read_with(cx, |s, app| s.query(app)), "");

    cx.simulate_keystrokes("escape");
    settle(cx);
    assert!(!settings.read_with(cx, |s, _| s.is_open()));
}

#[gpui::test]
fn general_and_chat_controls_update_the_settings_store(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::General, window, cx));
    settle(cx);

    // Default values in General
    let store = cx.read_global::<SettingsStore, _>(|s, _| s.clone());
    assert_eq!(store.default_editor, EditorChoice::Cursor);
    assert_eq!(store.chat_order, ChatOrder::Created);
    assert_eq!(store.chat_list, ChatListMode::List);
    assert_eq!(store.done_retention_hours, 24);
    assert_eq!(store.usage_display_mode, UsageDisplayMode::Used);
    assert!(store.show_usage_bars);
    assert!(store.keep_awake);

    // Pick Zed in Open files in select
    click(cx, "general-open-files-in");
    click(cx, "general-open-files-in-zed");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.default_editor), EditorChoice::Zed);

    // Pick Latest message first in Chat order
    click(cx, "general-chat-order");
    click(cx, "general-chat-order-recent");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.chat_order), ChatOrder::Recent);

    // Click By Project choice card
    click(cx, "choice-card-by-project");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.chat_list), ChatListMode::Grouped);

    // Toggle Show in sidebar and Keep the Mac awake checkboxes
    click(cx, "settings-row-show-in-sidebar");
    assert!(!cx.read_global::<SettingsStore, _>(|s, _| s.show_usage_bars));

    // Switch to Chat section and test its controls
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Chat, window, cx));
    settle(cx);

    click(cx, "chat-follow-ups");
    click(cx, "chat-follow-ups-queue");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.follow_ups), FollowUpMode::Queue);

    click(cx, "choice-card-expanded");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.expand_reasoning));

    click(cx, "choice-card-full-detail");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.tool_call_display), ToolCallDisplay::Full);
}

#[gpui::test]
fn notifications_and_models_controls_update_the_settings_store(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Notifications, window, cx));
    settle(cx);

    // Toggle Notify when finished checkbox
    click(cx, "settings-row-notify-when-finished");
    assert!(!cx.read_global::<SettingsStore, _>(|s, _| s.notify_on_complete));

    // Switch Notification schedule to Custom schedule and toggle Sunday on
    click(cx, "notifications-schedule-mode");
    click(cx, "notifications-schedule-mode-custom");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.notification_schedule.is_some()));
    click(cx, "notifications-day-sun");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| { s.notification_schedule.as_ref().unwrap().days.contains(&0) }));

    // Play chime button records last_played_chime
    click(cx, "notifications-play-chime");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.last_played_chime.clone()), Some("system".to_string()));

    // Switch to Models section
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Models, window, cx));
    settle(cx);

    click(cx, "models-default-permission");
    click(cx, "models-default-permission-auto");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.default_permission_mode), PermissionMode::Auto);

    // Increment button threshold, then reset thresholds
    click(cx, "models-button-threshold-inc");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.button_threshold), 75);
    click(cx, "models-reset-thresholds");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.button_threshold), 70);

    // Toggle Show Compact below threshold and TLDR writing
    click(cx, "settings-row-show-compact-below-threshold");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.compact_button_display), CompactButtonDisplay::Always);
    settings.update_in(cx, |s, _, cx| {
        s.body_scroll().set_offset(point(px(0.0), px(-300.0)));
        cx.notify();
    });
    settle(cx);
    click(cx, "settings-row-tldr-writing");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.tldr_enabled));

    click(cx, "models-claude-replies");
    click(cx, "models-claude-replies-concise");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.claude_reply_style), ClaudeReplyStyle::Concise);
}

#[gpui::test]
fn browser_church_and_about_controls_update_the_settings_store(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());

    // Browser section
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Browser, window, cx));
    settle(cx);
    click(cx, "browser-open-links-in");
    click(cx, "browser-open-links-in-panel");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.open_links_in), OpenLinksIn::Panel);

    click(cx, "browser-sign-out-local");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.signed_out_sessions.contains("local")));
    assert!(cx.debug_bounds("browser-sign-out-local-done").is_some());

    // Church (Experimental) section
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::Experimental, window, cx));
    settle(cx);
    click(cx, "settings-row-new-chat-stats");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.new_chat_stats));

    click(cx, "settings-row-device-notes");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.device_notes));

    // About section
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::About, window, cx));
    settle(cx);
    click(cx, "about-release-channel");
    click(cx, "about-release-channel-beta");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.release_channel), ReleaseChannel::Beta);

    click(cx, "about-check-updates");
    assert_eq!(cx.read_global::<SettingsStore, _>(|s, _| s.update_checks), 1);

    click(cx, "settings-row-auto-update");
    assert!(cx.read_global::<SettingsStore, _>(|s, _| s.auto_update));
}

/// Preview mode lists, searches and opens only the sections the data layer backs: Appearance always, Accounts, Usage
/// and Notifications once their globals are set; no other section, computer or Project page, and a request for one
/// falls back to Appearance.
#[gpui::test]
fn preview_settings_list_only_the_backed_sections(cx: &mut TestAppContext) {
    use crate::workspace::preview::{PreviewAccounts, PreviewMode, PreviewNotifications};
    let (workspace, cx) = testing::mount_workspace(cx);
    cx.update(|_, cx| {
        cx.set_global(PreviewMode { account: "test".into(), model: "test".into() });
        cx.set_global(PreviewAccounts(Vec::new()));
        cx.set_global(PreviewNotifications);
    });
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open(window, cx));
    settle(cx);
    assert_eq!(settings.read_with(cx, |s, _| s.selected_section_id()), SettingsSectionId::Appearance, "opens on Appearance");
    for shown in ["appearance", "accounts", "notifications"] {
        assert!(cx.debug_bounds(Box::leak(format!("settings-nav-{shown}").into_boxed_str())).is_some(), "{shown} is listed");
    }
    for hidden in ["general", "chat", "keybindings", "models", "usage", "skills", "mcp", "browser", "worktrees", "devices", "about"] {
        assert!(cx.debug_bounds(Box::leak(format!("settings-nav-{hidden}").into_boxed_str())).is_none(), "{hidden} is not listed");
    }
    assert!(cx.debug_bounds("settings-nav-this-mac").is_none(), "no computers group");
    assert!(cx.debug_bounds("settings-unavailable").is_none());
    // Search: only the listed sections' rows.
    settings.update_in(cx, |s, window, cx| s.set_query("keep awake", window, cx));
    settle(cx);
    assert!(settings.read_with(cx, |s, cx| s.current_hits(cx)).is_empty(), "a hidden section is not searched");
    settings.update_in(cx, |s, window, cx| s.set_query("chime", window, cx));
    settle(cx);
    let hits = settings.read_with(cx, |s, cx| s.current_hits(cx));
    assert!(!hits.is_empty() && hits.iter().all(|h| h.entry.page == SettingsSectionId::Notifications), "{hits:?}");
    // Notifications draws its page, without the attention button and Routines rows.
    settings.update_in(cx, |s, window, cx| s.set_query("", window, cx));
    click(cx, "settings-nav-notifications");
    assert!(cx.debug_bounds("settings-section-notifications").is_some());
    assert!(cx.debug_bounds("notifications-attention-button").is_none() && cx.debug_bounds("notifications-unread-runs-dot").is_none());
    // A hidden section asked for falls back to Appearance.
    settings.update(cx, |s, cx| s.select_section(super::SelectedSection::Section(SettingsSectionId::Mcp), cx));
    settle(cx);
    assert_eq!(settings.read_with(cx, |s, _| s.selected_section_id()), SettingsSectionId::Appearance);
    // Paired computers read with the vault unlocked: listed, each with a read-only page.
    cx.update(|_, cx| {
        cx.set_global(crate::workspace::preview::PreviewComputers(crate::data::ComputersSnapshot {
            this_mac: "Mac".into(),
            computers: vec![crate::data::Computer {
                id: "studio".into(),
                name: "Studio".into(),
                state: crate::data::ComputerState::Online,
                message: None,
            }],
        }))
    });
    settle(cx);
    click(cx, "settings-nav-computer-studio");
    assert!(cx.debug_bounds("settings-section-computer-studio").is_some(), "its read-only page");
    assert!(cx.debug_bounds("settings-nav-this-mac").is_none() && cx.debug_bounds("settings-nav-devices").is_none());
}

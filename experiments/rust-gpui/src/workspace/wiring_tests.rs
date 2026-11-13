//! The loose hooks the window wires together: onboarding with no Project, Settings › About driving the update card,
//! the first Chat's starters, the diff's Refresh, overlays hiding web pages, the context card's hover and focus.

use std::sync::Arc;
use std::time::Duration;

use gpui::{BorrowAppContext as _, Modifiers, TestAppContext, point, px};

use crate::data::{Data, FixtureSource};
use crate::notices::model::UpdateStatus;
use crate::platform::webview::WebOverlays;
use crate::settings::SettingsSectionId;
use crate::testing;

fn settle(cx: &mut gpui::VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
}

fn elapse(cx: &mut gpui::VisualTestContext, by: Duration) {
    cx.executor().advance_clock(by);
    settle(cx);
}

fn overlays(cx: &mut gpui::VisualTestContext) -> bool {
    cx.update(|_, cx| cx.try_global::<WebOverlays>().is_some_and(WebOverlays::any))
}

#[gpui::test]
fn onboarding_shows_when_there_is_no_project_and_skip_continues_into_the_app(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_in_root(cx, |window, cx| {
        cx.set_global(Data(Arc::new(FixtureSource::without_project())));
        super::Workspace::new(window, cx)
    });
    settle(cx);
    assert!(cx.debug_bounds("onboarding").is_some(), "no Project: onboarding covers the window");
    let click = |cx: &mut gpui::VisualTestContext, selector: &'static str| {
        let at = testing::bounds(cx, selector).center();
        cx.simulate_click(at, Modifiers::none());
        settle(cx);
    };
    click(cx, "onboarding-continue");
    click(cx, "onboarding-skip");
    assert!(cx.debug_bounds("onboarding").is_none());
    assert!(!workspace.read_with(cx, |w, cx| w.onboarding.read(cx).is_active()));
    assert!(cx.debug_bounds("composer").is_some(), "and the app is under it");
    assert!(cx.debug_bounds("first-chat-starters").is_none(), "a skip starts no first Chat");
}

#[gpui::test]
fn opening_a_project_from_onboarding_starts_the_first_chat_with_starters(cx: &mut TestAppContext) {
    let (_, cx) = testing::mount_in_root(cx, |window, cx| {
        cx.set_global(Data(Arc::new(FixtureSource::without_project())));
        super::Workspace::new(window, cx)
    });
    settle(cx);
    for selector in ["onboarding-continue", "onboarding-tile-open"] {
        let at = testing::bounds(cx, selector).center();
        cx.simulate_click(at, Modifiers::none());
        settle(cx);
    }
    elapse(cx, Duration::from_secs(1));
    assert!(cx.debug_bounds("onboarding").is_none());
    assert!(cx.debug_bounds("first-chat-starters").is_some(), "the opened Project's first Chat offers starters");
}

#[gpui::test]
fn a_window_with_a_project_has_no_onboarding(cx: &mut TestAppContext) {
    let (_, cx) = testing::mount_workspace(cx);
    assert!(cx.debug_bounds("onboarding").is_none());
}

#[gpui::test]
fn about_checks_for_updates_and_the_card_opens_when_one_downloads(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let settings = workspace.read_with(cx, |w, _| w.settings.clone());
    settings.update_in(cx, |s, window, cx| s.open_section(SettingsSectionId::About, window, cx));
    settle(cx);
    let notice = workspace.read_with(cx, |w, cx| w.notices.read(cx).update.clone());
    assert!(notice.read_with(cx, |n, _| n.state().is_none()));
    let at = testing::bounds(cx, "about-check-updates").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    assert_eq!(notice.read_with(cx, |n, _| n.state().map(|s| s.status)), Some(UpdateStatus::Checking));
    for _ in 0..5 {
        elapse(cx, Duration::from_millis(500));
    }
    assert_eq!(notice.read_with(cx, |n, _| n.state().map(|s| s.status)), Some(UpdateStatus::Downloaded));
    assert!(notice.read_with(cx, |n, _| n.is_open()), "a downloaded update opens its card");
}

#[gpui::test]
fn the_first_chat_shows_starters_over_the_composer_and_a_pick_sends_one(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let composer = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer.clone());
    assert!(cx.debug_bounds("first-chat-starters").is_none());
    cx.update(|window, cx| {
        composer.update(cx, |composer, cx| {
            composer.set_text("", window, cx);
            composer.start_new_chat(cx);
            composer.set_starters(Some("happiergym"), cx);
        })
    });
    settle(cx);
    let starters = testing::bounds(cx, "first-chat-starters");
    let tray = testing::bounds(cx, "new-chat-tray");
    assert!(starters.bottom() <= tray.top(), "the starters sit above the composer's tray");
    let at = testing::bounds(cx, "starter-bug").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("first-chat-starters").is_none(), "a pick takes the starters away");
    assert!(composer.read_with(cx, |c, _| c.starters().is_empty()));
}

#[gpui::test]
fn a_dialog_over_the_window_hides_web_pages(cx: &mut TestAppContext) {
    let (_, cx) = testing::mount_workspace(cx);
    assert!(!overlays(cx));
    cx.update(|window, cx| crate::ui::Dialog::new("Remove Project?").open(window, cx));
    settle(cx);
    assert!(overlays(cx), "a dialog is an overlay");
}

#[gpui::test]
fn the_context_card_opens_on_hover_and_closes_when_the_pointer_leaves(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let composer = workspace.read_with(cx, |w, cx| w.chat.read(cx).composer.clone());
    cx.update(|_, cx| composer.update(cx, |c, cx| c.set_context(120_000.0, 200_000.0, cx)));
    settle(cx);
    assert!(cx.debug_bounds("context-card").is_none());
    let ring = testing::bounds(cx, "composer-context-ring").center();
    cx.simulate_mouse_move(ring, None, Modifiers::none());
    settle(cx);
    assert!(cx.debug_bounds("context-card").is_none(), "not before the 120 ms delay");
    elapse(cx, Duration::from_millis(130));
    assert!(cx.debug_bounds("context-card").is_some(), "hovering the ring opens the card");
    assert!(overlays(cx), "an open popover hides web pages");
    cx.simulate_mouse_move(point(px(5.0), px(5.0)), None, Modifiers::none());
    settle(cx);
    elapse(cx, Duration::from_millis(160));
    assert!(cx.debug_bounds("context-card").is_none(), "and it closes after the pointer leaves");
    assert!(!overlays(cx), "and shows them again");
}

#[gpui::test]
fn the_diff_bars_refresh_reads_the_worktree_again(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace_on(cx, crate::workspace::panel::PanelTab::Changes);
    let changes = workspace.read_with(cx, |w, cx| w.panel.read(cx).changes().clone());
    let row = testing::bounds(cx, "file-u-apps/desktop/app/src/components/changes/ChangesPanel.tsx").center();
    cx.simulate_click(row, Modifiers::none());
    settle(cx);
    let pointer = |cx: &mut gpui::VisualTestContext| changes.read_with(cx, |changes, _| changes.data_ptr());
    let before = pointer(cx);
    assert_ne!(before, 0);
    let at = testing::bounds(cx, "diff-refresh").center();
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
    assert_ne!(pointer(cx), before, "Refresh hands the diff a fresh read");
    assert!(cx.debug_bounds("diff-refresh").is_some(), "and the diff stays open on the same file");
}

fn set_options(cx: &mut gpui::VisualTestContext, change: impl FnOnce(&mut crate::settings::appearance::AppearanceOptions)) {
    cx.update(|_, cx| {
        cx.update_global::<crate::settings::SettingsStore, _>(|store, _| change(&mut store.appearance.options));
    });
    settle(cx);
}

#[test]
fn the_live_style_follows_the_options_and_falls_back_to_the_system_font() {
    use crate::settings::appearance::AppearanceOptions;
    use crate::theme::SANS;
    let defaults = AppearanceOptions::default().live_style(&|_| true);
    assert_eq!(defaults, crate::theme::live::LiveStyle::default(), "the defaults are today's look");
    let options = AppearanceOptions {
        ui_font: "inter".into(),
        mono_font: "jetbrains-mono".into(),
        chat_size: "larger".into(),
        code_size: "large".into(),
        sidebar_size: "larger".into(),
        chat_width: "custom".into(),
        chat_width_px: 5000,
        provider_icons: "simplified".into(),
        sidebar_usage: "compact".into(),
        ..AppearanceOptions::default()
    };
    let live = options.live_style(&|family| family == "Inter" || family == "JetBrains Mono");
    assert_eq!((live.ui_font, live.mono_font), ("Inter", Some("JetBrains Mono")));
    assert_eq!((live.chat_size, live.code_size, live.sidebar_delta, live.chat_width), (17.0, 14.0, 2.0, Some(2400.0)));
    assert!(live.simplified_icons && live.compact_usage);
    let missing = options.live_style(&|_| false);
    assert_eq!((missing.ui_font, missing.mono_font), (SANS, None), "a font that is not installed is the system font");
}

#[gpui::test]
fn the_appearance_choices_reach_the_real_views_and_rebuild_them_once(cx: &mut TestAppContext) {
    let (workspace, cx) = testing::mount_workspace(cx);
    let transcript = workspace.read_with(cx, |w, cx| w.chat.read(cx).transcript.clone());
    let composer_width = |cx: &mut gpui::VisualTestContext| testing::bounds(cx, "composer").size.width;
    let narrow = composer_width(cx);
    assert_eq!(narrow, px(crate::theme::live::DEFAULT_COLUMN));
    let usage_row = |cx: &mut gpui::VisualTestContext| cx.debug_bounds("usage-row-Claude");
    assert!(usage_row(cx).is_some(), "expanded usage rows at the start");

    let before = transcript.read_with(cx, |t, _| t.item_renders());
    set_options(cx, |options| {
        options.chat_size = "larger".into();
        options.chat_width = "wide".into();
        options.sidebar_usage = "compact".into();
        options.sidebar_size = "large".into();
    });
    assert_eq!(crate::theme::chat_text().size, 17.0);
    assert_eq!(crate::theme::prompt_text_size(), 18.0);
    assert!(composer_width(cx) > narrow, "a wider Chat column widens the composer");
    assert!(usage_row(cx).is_none() && cx.debug_bounds("usage-mark-Claude").is_some(), "compact usage draws marks");
    assert!(transcript.read_with(cx, |t, _| t.item_renders()) > before, "the change rebuilt the transcript");
    // The list re-measures its items over a frame or two; after that nothing rebuilds it per frame.
    cx.run_until_parked();
    let after = transcript.read_with(cx, |t, _| t.item_renders());
    for _ in 0..3 {
        cx.run_until_parked();
    }
    assert_eq!(transcript.read_with(cx, |t, _| t.item_renders()), after, "once, not per frame");
}

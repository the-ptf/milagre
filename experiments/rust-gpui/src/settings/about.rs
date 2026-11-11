//! About Settings section (`AboutSettings` in `Settings.tsx`).

use gpui::{App, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use super::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use super::store::{ReleaseChannel, SettingsStore};
use crate::notices::model::{AppUpdate, UpdateStatus};
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt, mono};
use crate::ui::{Button, ButtonSize, ButtonVariant, Select, SelectOption};

/// The Updates row's line (`updateDescription` in `packages/shared/src/app-update.ts`).
fn update_description(update: Option<&AppUpdate>) -> String {
    let Some(update) = update else { return "Check for the latest Milagre release.".to_string() };
    let named = |fallback: &str| match update.version.as_deref() {
        Some(version) if !version.is_empty() => format!("Milagre {version}"),
        _ => fallback.to_string(),
    };
    match update.status {
        UpdateStatus::Checking => "Checking for updates\u{2026}".to_string(),
        UpdateStatus::UpToDate => "Milagre is up to date.".to_string(),
        UpdateStatus::Downloading => format!("Downloading {}\u{2026} {}%", named("update"), update.percent()),
        UpdateStatus::Downloaded => format!(
            "{} is ready to install.{}",
            named("The update"),
            if update.auto { " Auto update installs it once nothing is running." } else { "" }
        ),
        UpdateStatus::Installing => "Saving your work and restarting Milagre.".to_string(),
        UpdateStatus::Error => update.error.clone().unwrap_or_else(|| "Couldn't check for updates. Try again.".to_string()),
        UpdateStatus::Unavailable => "Update checks are available in the installed app.".to_string(),
        UpdateStatus::Idle => "Check for the latest Milagre release.".to_string(),
    }
}

pub fn render_about(highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let theme = *cx.theme();
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    let channel_desc = if store.release_channel == ReleaseChannel::Beta {
        "Receives beta builds ahead of stable releases"
    } else {
        "Receives stable releases"
    };

    let channel_select = Select::new(
        "about-release-channel",
        store.release_channel.as_str(),
        [SelectOption::new("stable", "Stable"), SelectOption::new("beta", "Beta")],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.release_channel = ReleaseChannel::parse(val));
    });

    // The Updates row follows the updater's state (`updateDescription` in app-update.ts), driven by the fixture feed.
    let update = crate::notices::driver::state(cx);
    let status = update.as_ref().map(|update| update.status);
    let updates_desc = update_description(update.as_ref());
    let busy =
        matches!(status, Some(UpdateStatus::Checking | UpdateStatus::Downloading | UpdateStatus::Installing | UpdateStatus::Unavailable));
    let check_label = match status {
        Some(UpdateStatus::Installing) => "Restarting\u{2026}",
        Some(UpdateStatus::Downloaded) => "Install & restart",
        _ => "Check for updates",
    };

    let check_button =
        Button::new("about-check-updates", check_label).variant(ButtonVariant::Secondary).size(ButtonSize::S28).disabled(busy).on_click(
            |_, window, cx| {
                cx.update_global::<SettingsStore, _>(|s, _| s.update_checks += 1);
                crate::notices::driver::press(window, cx);
            },
        );

    let updates_hl = if highlighted == Some("Check for updates") { Some("Updates") } else { highlighted };

    let milagre_group = SettingsGroup::new()
        .title("Milagre")
        .highlighted_row(hl_shared)
        .row(
            SettingRow::new("Version")
                .highlighted(highlighted)
                .control(
                    div()
                        .font_family(mono())
                        .text_step(TEXT_12)
                        .text_color(theme.ink2)
                        .child("0.1.0"),
                ),
        )
        .row(
            SettingRow::new("Release channel")
                .description(channel_desc)
                .highlighted(highlighted)
                .control(channel_select),
        )
        .row(
            SettingRow::new("Updates")
                .description(updates_desc)
                .highlighted(updates_hl)
                .control(check_button),
        )
        .row(
            CheckboxRow::new("about-auto-update", "Auto update", store.auto_update)
                .description("Installs a downloaded update by itself once no Chat or Routine is running and nobody has used the Mac for 5 minutes. For a Mac nobody watches, like a server.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.auto_update = next);
                }),
        )
        .row(
            SettingRow::new("Runtime")
                .highlighted(highlighted)
                .control(
                    div()
                        .font_family(mono())
                        .text_step(TEXT_12)
                        .text_color(theme.ink3)
                        .child("GPUI 0.3.12 · Rust"),
                ),
        )
        .row(
            SettingRow::new("License")
                .highlighted(highlighted)
                .control(div().text_step(TEXT_12).text_color(theme.ink2).child("MIT")),
        )
        .row(
            SettingRow::new("Privacy policy")
                .highlighted(highlighted)
                .control(div().text_step(TEXT_12).text_color(theme.ink2).child("milagre.dev/privacy")),
        )
        .row(
            SettingRow::new("Support")
                .highlighted(highlighted)
                .control(div().text_step(TEXT_12).text_color(theme.ink2).child("milagre.dev/support")),
        );

    div().debug_selector(|| "settings-section-about".into()).flex().flex_col().child(page_header("About", None, cx)).child(milagre_group)
}

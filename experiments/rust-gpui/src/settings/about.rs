//! About Settings section (`AboutSettings` in `Settings.tsx`).

use gpui::{App, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use super::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use super::store::{ReleaseChannel, SettingsStore};
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt, mono};
use crate::ui::{Button, ButtonSize, ButtonVariant, Select, SelectOption};

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

    let updates_desc =
        if store.update_checks > 0 { "You're on the latest version" } else { "Automatic checks run on launch and every hour" };

    let check_button = Button::new("about-check-updates", "Check for updates")
        .variant(ButtonVariant::Secondary)
        .size(ButtonSize::S28)
        .on_click(|_, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.update_checks += 1);
        });

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

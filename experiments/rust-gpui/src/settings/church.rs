//! Church (Experimental) Settings section (`ExperimentalSettings` in `Settings.tsx`).

use gpui::{App, IntoElement, ParentElement, SharedString, Styled, div, prelude::*};

use super::group::{CheckboxRow, SettingsGroup, page_header};
use super::store::SettingsStore;

pub fn render_church(highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    let shows = |title: &str| super::group::shows(cx, super::SettingsSectionId::Experimental, title);
    let beta_group = SettingsGroup::new()
        .title("Beta")
        .highlighted_row(hl_shared)
        .row_if(
            shows("Ultracode Fatality"),
            CheckboxRow::new("church-ultracode-fatality", "Ultracode Fatality", store.ultracode_fatality)
                .description("Turning Ultracode on darkens the window, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.ultracode_fatality = next);
                }),
        )
        .row_if(
            shows("New Chat stats"),
            CheckboxRow::new("church-new-chat-stats", "New Chat stats", store.new_chat_stats)
                .description("Open pull requests, plan usage and today's tokens on a new Chat.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.new_chat_stats = next);
                }),
        )
        .row_if(
            shows("Delegate to other computers"),
            CheckboxRow::new("church-delegate-computers", "Delegate to other computers", store.delegate_to_other_computers)
                .description("A Chat's agent can hand work to a Project on another paired computer. That computer runs the turn, and this Chat shows it as it runs. Needs Drive other computers on in Settings > Devices.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.delegate_to_other_computers = next);
                }),
        )
        .row_if(
            shows("Device notes"),
            CheckboxRow::new("church-device-notes", "Device notes", store.device_notes)
                .description("Tell a Chat's agent when you write from your phone, iPad or another computer, so it doesn't ask you to open files or apps on the Mac.")
                .warning("Adds about 100 tokens to every message you send from another device.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.device_notes = next);
                }),
        );

    div()
        .debug_selector(|| "settings-section-experimental".into())
        .flex()
        .flex_col()
        .child(page_header("Church", Some("Features still in progress. May change or be removed."), cx))
        .child(beta_group)
}

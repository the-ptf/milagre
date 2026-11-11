//! General Settings section (`GeneralSettings` in `Settings.tsx` and `ChatListCards` in `ChatDisplayChoices.tsx`).

use gpui::{App, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::group::{CheckboxRow, ChoiceCard, SettingRow, SettingsGroup, page_header};
use super::store::{ChatListMode, EditorChoice, SettingsStore, UsageDisplayMode};
use crate::logic::lists::order::ChatOrder;
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_11, TEXT_13, TextStepExt};
use crate::ui::{Icon, IconName, IconSize, ProjectAvatar, Select, SelectOption};

const DONE_RETENTION_OPTIONS: &[(u32, &str)] =
    &[(1, "1 hour"), (8, "8 hours"), (24, "24 hours"), (72, "3 days"), (168, "1 week"), (0, "Never")];

pub fn render_general(highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    // Editor group
    let editor_select = Select::new(
        "general-open-files-in",
        store.default_editor.as_str(),
        [
            SelectOption::new("cursor", "Cursor"),
            SelectOption::new("vscode", "VS Code"),
            SelectOption::new("zed", "Zed"),
            SelectOption::new("system", "System default"),
        ],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.default_editor = EditorChoice::parse(val));
    });

    let editor_group = SettingsGroup::new()
        .title("Editor")
        .highlighted_row(hl_shared.clone())
        .row(SettingRow::new("Open files in").highlighted(highlighted).control(editor_select));

    // Sidebar group
    let chat_order_value = match store.chat_order {
        ChatOrder::Created => "created",
        ChatOrder::Recent => "recent",
    };
    let chat_order_select = Select::new(
        "general-chat-order",
        chat_order_value,
        [SelectOption::new("created", "Newest Chat first"), SelectOption::new("recent", "Latest message first")],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| {
            s.chat_order = if val == "recent" { ChatOrder::Recent } else { ChatOrder::Created };
        });
    });

    let sidebar_group = SettingsGroup::new().title("Sidebar").highlighted_row(hl_shared.clone()).row(
        SettingRow::new("Chat order")
            .description("Newest Chat first keeps chats in place as replies arrive")
            .highlighted(highlighted)
            .control(chat_order_select),
    );

    // Chat list choice cards (`ChatListCards` in `ChatDisplayChoices.tsx`)
    let chat_list_cards = render_chat_list_cards(store.chat_list, highlighted, cx);

    // Done group
    let retention_val = store.done_retention_hours.to_string();
    let retention_options = DONE_RETENTION_OPTIONS.iter().map(|(hours, label)| SelectOption::new(hours.to_string(), *label));
    let done_select = Select::new("general-done-retention", retention_val, retention_options).on_change(|val, _, cx| {
        if let Ok(hours) = val.parse::<u32>() {
            cx.update_global::<SettingsStore, _>(|s, _| s.done_retention_hours = hours);
        }
    });

    let done_group = SettingsGroup::new()
        .title("Done")
        .description("Marking a Chat Done moves it to the Done list at the bottom of the sidebar. After this time, Milagre archives it and removes its worktree if nothing in it is unsaved.")
        .highlighted_row(hl_shared.clone())
        .row(
            SettingRow::new("Archive Done Chats after")
                .highlighted(highlighted)
                .control(done_select),
        );

    // Plan usage group
    let usage_select = Select::new(
        "general-plan-usage-show",
        store.usage_display_mode.as_str(),
        [SelectOption::new("used", "Used"), SelectOption::new("remaining", "Remaining")],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.usage_display_mode = UsageDisplayMode::parse(val));
    });

    let plan_usage_group = SettingsGroup::new()
        .title("Plan usage")
        .highlighted_row(hl_shared.clone())
        .row(
            SettingRow::new("Show").description("Claude, Codex and Antigravity plan limits").highlighted(highlighted).control(usage_select),
        )
        .row(
            CheckboxRow::new("general-show-in-sidebar", "Show in sidebar", store.show_usage_bars)
                .description("Hover a provider for its limits and reset times")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.show_usage_bars = next);
                }),
        );

    // System group
    let system_group = SettingsGroup::new()
        .title("System")
        .highlighted_row(hl_shared)
        .row(
            CheckboxRow::new("general-keep-awake", "Keep the Mac awake", store.keep_awake)
                .description("While Milagre runs, so your phone and other computers can reach it. The screen can still turn off. Plugged in, it stays awake with the lid closed; on battery, closing the lid sleeps it.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.keep_awake = next);
                }),
        );

    div()
        .debug_selector(|| "settings-section-general".into())
        .flex()
        .flex_col()
        .child(page_header("General", None, cx))
        .child(editor_group)
        .child(sidebar_group)
        .child(chat_list_cards)
        .child(done_group)
        .child(plan_usage_group)
        .child(system_group)
}

fn render_chat_list_cards(selected: ChatListMode, highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let theme = *cx.theme();
    let heading_matched = highlighted == Some("Chat list");

    let one_list_preview = div()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .text_step(TEXT_11)
        .child(
            div()
                .rounded(RADIUS_CONTROL)
                .bg(theme.hover2)
                .px(px(6.0))
                .py(px(4.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(div().size(px(6.0)).rounded_full().bg(theme.accent))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Fix auth redirect"))
                        .child(div().text_color(theme.ink3).child("milagre · 2m")),
                ),
        )
        .child(
            div()
                .px(px(6.0))
                .py(px(4.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(div().size(px(6.0)).rounded_full().bg(theme.green))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Release notes"))
                        .child(div().text_color(theme.ink3).child("docs · 1h")),
                ),
        );

    let grouped_preview = div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .text_step(TEXT_11)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink)
                .child(ProjectAvatar::new("milagre").size(14.0))
                .child("milagre"),
        )
        .child(
            div()
                .pl(px(12.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().size(px(6.0)).rounded_full().bg(theme.accent))
                .child("Fix auth redirect"),
        )
        .child(
            div()
                .pt(px(2.0))
                .flex()
                .items_center()
                .gap(px(6.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::ArrowRight01).size(IconSize::S12)))
                .child(ProjectAvatar::new("docs").size(14.0))
                .child("docs"),
        );

    div()
        .mb(px(24.0))
        .flex()
        .flex_col()
        .child(
            div()
                .px(px(4.0))
                .mb(px(6.0))
                .rounded(RADIUS_CONTROL)
                .when(heading_matched, |d| d.bg(theme.hover2).debug_selector(|| "settings-found-row".into()))
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .child("Chat list"),
        )
        .child(
            div()
                .flex()
                .gap(px(10.0))
                .child(
                    ChoiceCard::new(
                        "general-chat-list-one",
                        "One list",
                        "Newest first, Project on each row.",
                        selected == ChatListMode::List,
                    )
                    .highlighted(highlighted)
                    .preview(one_list_preview)
                    .on_click(|_, _, cx| {
                        cx.update_global::<SettingsStore, _>(|s, _| s.chat_list = ChatListMode::List);
                    }),
                )
                .child(
                    ChoiceCard::new(
                        "general-chat-list-grouped",
                        "By Project",
                        "A group per Project that folds.",
                        selected == ChatListMode::Grouped,
                    )
                    .highlighted(highlighted)
                    .preview(grouped_preview)
                    .on_click(|_, _, cx| {
                        cx.update_global::<SettingsStore, _>(|s, _| s.chat_list = ChatListMode::Grouped);
                    }),
                ),
        )
}

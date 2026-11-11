//! Chat Settings section (`ChatSettings` in `Settings.tsx` and `ChatDisplayChoices` in `ChatDisplayChoices.tsx`).

use gpui::{App, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::group::{ChoiceCard, SettingRow, SettingsGroup, page_header};
use super::store::{FollowUpMode, SettingsStore, ToolCallDisplay};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_11, TEXT_13, TextStepExt};
use crate::ui::{Icon, IconName, IconSize, Select, SelectOption};

pub fn render_chat(highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    let follow_ups_select = Select::new(
        "chat-follow-ups",
        store.follow_ups.as_str(),
        [
            SelectOption::new("now", "Send now").description("Steers the running turn. Agents that can't steer get it when the turn ends."),
            SelectOption::new("queue", "Queue").description("Waits for the turn to end. Send now on a queued message sends it right away."),
        ],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.follow_ups = FollowUpMode::parse(val));
    });

    let messages_group = SettingsGroup::new().title("Messages during a turn").highlighted_row(hl_shared).row(
        SettingRow::new("While the agent works")
            .description("Send now steers the running turn; Queue waits for it to end.")
            .highlighted(highlighted)
            .control(follow_ups_select),
    );

    let reasoning_cards = render_reasoning_cards(store.expand_reasoning, highlighted, cx);
    let tool_call_cards = render_tool_call_cards(store.tool_call_display, highlighted, cx);

    div()
        .debug_selector(|| "settings-section-chat".into())
        .flex()
        .flex_col()
        .child(page_header("Chat", Some("How messages and turns appear in the transcript."), cx))
        .child(messages_group)
        .child(reasoning_cards)
        .child(tool_call_cards)
}

fn render_reasoning_cards(expanded: bool, highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let theme = *cx.theme();
    let heading_matched = highlighted == Some("Reasoning");

    let folded_preview = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .text_step(TEXT_11)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::ArrowRight01).size(IconSize::S12)))
                .child("Thought for 4s"),
        )
        .child(div().text_color(theme.ink).child("Updated the token check in auth.ts."));

    let expanded_preview = div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .text_step(TEXT_11)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::ArrowDown01).size(IconSize::S12)))
                .child("Thought for 4s"),
        )
        .child(
            div()
                .pl(px(12.0))
                .border_l_1()
                .border_color(theme.line)
                .text_color(theme.ink3)
                .child("The session cookie expires before the refresh runs…"),
        )
        .child(div().pt(px(2.0)).text_color(theme.ink).child("Updated the token check."));

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
                .child("Reasoning"),
        )
        .child(
            div()
                .flex()
                .gap(px(10.0))
                .child(
                    ChoiceCard::new("chat-reasoning-folded", "Folded", "Thinking stays in its row until you open it.", !expanded)
                        .highlighted(highlighted)
                        .preview(folded_preview)
                        .on_click(|_, _, cx| {
                            cx.update_global::<SettingsStore, _>(|s, _| s.expand_reasoning = false);
                        }),
                )
                .child(
                    ChoiceCard::new("chat-reasoning-expanded", "Expanded", "Thinking shows open above each answer.", expanded)
                        .highlighted(highlighted)
                        .preview(expanded_preview)
                        .on_click(|_, _, cx| {
                            cx.update_global::<SettingsStore, _>(|s, _| s.expand_reasoning = true);
                        }),
                ),
        )
}

fn render_tool_call_cards(selected: ToolCallDisplay, highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let theme = *cx.theme();
    let heading_matched = highlighted == Some("Tool calls");

    let compact_preview = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .text_step(TEXT_11)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::ArrowRight01).size(IconSize::S12)))
                .child("Read 2 files · Edited auth.ts · Ran 1 command"),
        )
        .child(div().text_color(theme.ink).child("The redirect now preserves the query string."));

    let full_preview = div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .text_step(TEXT_11)
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::File01).size(IconSize::S12)))
                .child(div().child("Read "))
                .child(div().text_color(theme.ink3).child("src/auth.ts")),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::PencilEdit02).size(IconSize::S12)))
                .child(div().child("Edited "))
                .child(div().text_color(theme.ink3).child("src/auth.ts"))
                .child(div().text_color(theme.green).child("+6"))
                .child(div().text_color(theme.red).child("-2")),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_color(theme.ink2)
                .child(div().text_color(theme.ink3).child(Icon::new(IconName::ComputerTerminal01).size(IconSize::S12)))
                .child(div().child("Ran "))
                .child(div().text_color(theme.ink3).child("npm test")),
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
                .child("Tool calls"),
        )
        .child(
            div()
                .flex()
                .gap(px(10.0))
                .child(
                    ChoiceCard::new("chat-tool-calls-compact", "Compact", "One line per reply.", selected == ToolCallDisplay::Compact)
                        .highlighted(highlighted)
                        .preview(compact_preview)
                        .on_click(|_, _, cx| {
                            cx.update_global::<SettingsStore, _>(|s, _| s.tool_call_display = ToolCallDisplay::Compact);
                        }),
                )
                .child(
                    ChoiceCard::new("chat-tool-calls-full", "Full detail", "Each call on its own row.", selected == ToolCallDisplay::Full)
                        .highlighted(highlighted)
                        .preview(full_preview)
                        .on_click(|_, _, cx| {
                            cx.update_global::<SettingsStore, _>(|s, _| s.tool_call_display = ToolCallDisplay::Full);
                        }),
                ),
        )
}

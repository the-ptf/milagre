//! Models Settings section (`ModelsSettings` in `Settings.tsx` and `ContextSettings` in `ContextSettings.tsx`).

use gpui::{App, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use super::store::{ClaudeReplyStyle, CompactButtonDisplay, MODEL_CATALOG, PermissionMode, SettingsStore};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CARD, RADIUS_CONTROL, TEXT_11, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize, Select, SelectOption};

pub fn render_models(highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    // New chats group
    let model_options = MODEL_CATALOG.iter().map(|m| SelectOption::new(m.id, m.name).description(m.description));
    let model_select = Select::new("models-default-model", store.default_model.clone(), model_options).on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.default_model = val.to_string());
    });

    let perm_options = [
        SelectOption::new("ask", "Ask for approval").description("Approve edits and commands as the agent asks"),
        SelectOption::new("auto", "Auto mode").description("Allow changes inside this Worktree"),
        SelectOption::new("full", "Full permissions").description("Remove filesystem and network limits"),
    ];
    let perm_select =
        Select::new("models-default-permission", store.default_permission_mode.as_str(), perm_options).on_change(|val, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.default_permission_mode = PermissionMode::parse(val));
        });

    let new_chats_group = SettingsGroup::new()
        .title("New chats")
        .highlighted_row(hl_shared.clone())
        .row(
            SettingRow::new("Default model")
                .description("Used for new chats; remembers your last selection")
                .highlighted(highlighted)
                .control(model_select),
        )
        .row(
            SettingRow::new("Default permission")
                .description("Used for new chats; remembers your last selection")
                .highlighted(highlighted)
                .control(perm_select),
        );

    // Context group (`ContextSettings.tsx`)
    let context_section = render_context_settings(&store, highlighted, hl_shared.clone(), cx);

    // Replies group
    let claude_replies_select = Select::new(
        "models-claude-replies",
        store.claude_reply_style.as_str(),
        [SelectOption::new("default", "Default"), SelectOption::new("concise", "Concise")],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| s.claude_reply_style = ClaudeReplyStyle::parse(val));
    });

    let replies_description = if store.claude_reply_style == ClaudeReplyStyle::Concise {
        "Instructs Claude on the first turn of each new chat to keep updates to a sentence and skip trailing summaries"
    } else {
        "Claude's normal reply length"
    };

    let replies_group = SettingsGroup::new()
        .title("Replies")
        .highlighted_row(hl_shared)
        .row(
            CheckboxRow::new("models-tldr-writing", "TLDR writing", store.tldr_enabled)
                .description("Shape Claude, Codex and Antigravity updates and replies with /tldr. Applies on the next turn after the current reply finishes.")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.tldr_enabled = next);
                }),
        )
        .row(
            SettingRow::new("Claude replies")
                .description(replies_description)
                .highlighted(highlighted)
                .control(claude_replies_select),
        );

    div()
        .debug_selector(|| "settings-section-models".into())
        .flex()
        .flex_col()
        .child(page_header("Models", Some("Default model and permission mode for new chats."), cx))
        .child(new_chats_group)
        .child(context_section)
        .child(replies_group)
}

fn render_context_settings(
    store: &SettingsStore,
    highlighted: Option<&str>,
    hl_shared: Option<SharedString>,
    cx: &App,
) -> impl IntoElement {
    let theme = *cx.theme();
    let quiet = store.auto_compact;
    let show_always = store.compact_button_display == CompactButtonDisplay::Always;
    let changed = store.button_threshold != 70 || store.auto_threshold != 85;
    let context_heading_matched = highlighted == Some("Context");

    // Preview box (`ContextPreview` in `ContextSettings.tsx`)
    let preview = div()
        .mb(px(10.0))
        .rounded(RADIUS_CARD)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .px(px(14.0))
        .py(px(10.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .child(
            div()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(6.0))
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child(
                    div()
                        .rounded(RADIUS_CONTROL)
                        .border_1()
                        .border_color(theme.line)
                        .bg(theme.surface)
                        .px(px(8.0))
                        .py(px(2.0))
                        .text_color(theme.ink2)
                        .child("Opus 5.5"),
                )
                .child(
                    div()
                        .rounded(RADIUS_CONTROL)
                        .border_1()
                        .border_color(theme.line)
                        .bg(theme.surface)
                        .px(px(8.0))
                        .py(px(2.0))
                        .text_color(theme.ink2)
                        .child("High"),
                ),
        )
        .child(
            div()
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(6.0))
                .when(!quiet && (show_always || store.button_threshold <= 72), |d| {
                    let at_threshold = !show_always;
                    d.child(
                        div()
                            .h(CONTROL_SM)
                            .px(px(8.0))
                            .rounded(RADIUS_CONTROL)
                            .border_1()
                            .border_color(if at_threshold { theme.orange } else { theme.line })
                            .bg(if at_threshold { theme.orange_tint } else { theme.surface })
                            .text_step(TEXT_12)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if at_threshold { theme.orange_ink } else { theme.ink2 })
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(Icon::new(IconName::Clean).size(IconSize::S14))
                            .child("Compact"),
                    )
                })
                .when(!quiet && store.show_context_size, |d| {
                    d.child(
                        div()
                            .h(CONTROL_SM)
                            .px(px(6.0))
                            .rounded(RADIUS_CONTROL)
                            .text_step(TEXT_11)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.ink2)
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .child(div().size(px(12.0)).rounded_full().border_2().border_color(theme.orange))
                            .child("144k"),
                    )
                })
                .child(
                    div()
                        .size(CONTROL_SM)
                        .rounded_full()
                        .bg(theme.accent)
                        .text_color(theme.on_accent)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(Icon::new(IconName::ArrowUp02).size(IconSize::S14)),
                ),
        );

    // Thresholds row (`Thresholds on this computer`)
    let thr_highlighted = highlighted == Some("Thresholds on this computer") || highlighted == Some("Reset to defaults");
    let button_pct = store.button_threshold;
    let auto_pct = store.auto_threshold;

    // Visual track bar with markers at button_pct and auto_pct
    let track = div()
        .mt(px(14.0))
        .relative()
        .h(px(28.0))
        .w_full()
        .flex()
        .items_center()
        .child(
            div()
                .h(px(10.0))
                .w_full()
                .rounded_full()
                .border_1()
                .border_color(theme.line)
                .bg(theme.field)
                .overflow_hidden()
                .flex()
                .child(div().w(gpui::relative(0.55)).h_full().bg(theme.green))
                .child(div().w(gpui::relative(0.23)).h_full().bg(theme.orange))
                .child(div().flex_1().h_full().bg(theme.red)),
        )
        .when(!quiet, |d| {
            d.child(
                div()
                    .absolute()
                    .left(gpui::relative(f32::from(button_pct) / 100.0))
                    .ml(px(-9.0))
                    .size(px(18.0))
                    .rounded_full()
                    .border_2()
                    .border_color(theme.orange)
                    .bg(theme.surface),
            )
        })
        .child(
            div()
                .absolute()
                .left(gpui::relative(f32::from(auto_pct) / 100.0))
                .ml(px(-9.0))
                .size(px(18.0))
                .rounded_full()
                .border_2()
                .border_color(theme.red)
                .bg(theme.surface),
        );

    // Stepper controls for Compact button % and Auto compact %
    let btn_minus = Button::new("models-button-threshold-dec", "-")
        .variant(ButtonVariant::Secondary)
        .size(ButtonSize::S24)
        .disabled(quiet || button_pct <= 5)
        .on_click(move |_, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.set_button_threshold(s.button_threshold.saturating_sub(5)));
        });
    let btn_plus = Button::new("models-button-threshold-inc", "+")
        .variant(ButtonVariant::Secondary)
        .size(ButtonSize::S24)
        .disabled(quiet || button_pct >= 90)
        .on_click(move |_, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.set_button_threshold(s.button_threshold.saturating_add(5)));
        });

    let auto_minus = Button::new("models-auto-threshold-dec", "-")
        .variant(ButtonVariant::Secondary)
        .size(ButtonSize::S24)
        .disabled(auto_pct <= button_pct + 5)
        .on_click(move |_, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.set_auto_threshold(s.auto_threshold.saturating_sub(5)));
        });
    let auto_plus = Button::new("models-auto-threshold-inc", "+")
        .variant(ButtonVariant::Secondary)
        .size(ButtonSize::S24)
        .disabled(auto_pct >= 95)
        .on_click(move |_, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.set_auto_threshold(s.auto_threshold.saturating_add(5)));
        });

    let legend = div()
        .mt(px(12.0))
        .flex()
        .flex_wrap()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .text_step(TEXT_12)
        .child(
            div()
                .when(quiet, |d| d.opacity(0.45))
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().size(px(8.0)).rounded_full().bg(theme.orange))
                .child(div().text_color(theme.ink2).child("Compact button"))
                .child(btn_minus)
                .child(
                    div()
                        .debug_selector(|| "models-button-threshold-value".into())
                        .min_w(px(36.0))
                        .text_center()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink)
                        .child(format!("{button_pct}%")),
                )
                .child(btn_plus),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(div().size(px(8.0)).rounded_full().bg(theme.red))
                .child(div().text_color(theme.ink2).child("Auto compact"))
                .child(auto_minus)
                .child(
                    div()
                        .debug_selector(|| "models-auto-threshold-value".into())
                        .min_w(px(36.0))
                        .text_center()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.ink)
                        .child(format!("{auto_pct}%")),
                )
                .child(auto_plus),
        );

    let reset_button = Button::new("models-reset-thresholds", "Reset to defaults")
        .variant(ButtonVariant::Ghost)
        .size(ButtonSize::S24)
        .disabled(!changed)
        .on_click(|_, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| s.reset_context_thresholds());
        });

    let thresholds_row = div()
        .debug_selector(move || {
            if thr_highlighted { "settings-found-row".to_string() } else { "settings-row-thresholds-on-this-computer".to_string() }
        })
        .px(px(16.0))
        .py(px(12.0))
        .when(thr_highlighted, |d| d.bg(theme.hover2))
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_baseline()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_step(TEXT_13)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink)
                                .child("Thresholds on this computer"),
                        )
                        .child(
                            div()
                                .mt(px(2.0))
                                .text_step(TEXT_12)
                                .text_color(theme.ink3)
                                .child("Drag either marker or enter a percentage. Auto compact waits for the reply to finish."),
                        ),
                )
                .child(reset_button),
        )
        .child(track)
        .child(legend);

    let show_below_desc = if show_always {
        format!("Compact stays beside Send and turns orange at {button_pct}%.")
    } else {
        format!("Off by default. The button appears only at {button_pct}%.")
    };

    let group = SettingsGroup::new()
        .highlighted_row(hl_shared)
        .row(
            CheckboxRow::new("models-context-size", "Context size beside Send", !quiet && store.show_context_size)
                .description("Click it for usage and Compact now.")
                .disabled(quiet)
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.show_context_size = next);
                }),
        )
        .row(
            CheckboxRow::new("models-auto-compact", "Auto compact quietly", store.auto_compact)
                .description(format!("Compacts at {auto_pct}% without context controls or notifications."))
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.auto_compact = next);
                }),
        )
        .row(thresholds_row)
        .row(
            CheckboxRow::new("models-show-compact-below", "Show Compact below threshold", !quiet && show_always)
                .description(show_below_desc)
                .disabled(quiet)
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| {
                        s.compact_button_display = if next { CompactButtonDisplay::Always } else { CompactButtonDisplay::Threshold };
                    });
                }),
        );

    div()
        .flex()
        .flex_col()
        .child(
            div()
                .px(px(4.0))
                .mb(px(2.0))
                .rounded(RADIUS_CONTROL)
                .when(context_heading_matched, |d| d.bg(theme.hover2).debug_selector(|| "settings-found-row".into()))
                .text_step(TEXT_13)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .child("Context"),
        )
        .child(
            div()
                .mb(px(8.0))
                .px(px(4.0))
                .text_step(TEXT_12)
                .text_color(theme.ink3)
                .child("Compact summarizes earlier messages so a long Chat can keep going."),
        )
        .child(preview)
        .child(group)
}

//! Notifications Settings section (`NotificationsSettings` in `Settings.tsx` and
//! `NotificationScheduleSetting.tsx`).

use gpui::{App, ElementId, FontWeight, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use super::store::{NotificationSchedule, SettingsStore};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, IconName, Select, SelectOption};

pub const NOTIFICATION_CHIMES: &[(&str, &str)] = &[
    ("system", "System default"),
    ("miracle", "Miracle"),
    ("faaah", "FAAAH"),
    ("bombastic-side-eye", "Bombastic side eye"),
    ("vine-boom", "Vine boom"),
    ("metal-pipe", "Metal pipe"),
    ("bruh", "Bruh"),
    ("emotional-damage", "Emotional damage"),
];

pub const NOTIFICATION_DAYS: &[&str] = &["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

pub const NOTIFICATION_TIME_ZONES: &[&str] = &[
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Asia/Singapore",
    "Australia/Sydney",
];

fn notification_times() -> Vec<(String, String)> {
    (0..48)
        .map(|index| {
            let hour = index / 2;
            let mins = if index % 2 == 1 { "30" } else { "00" };
            let value = format!("{hour:02}:{mins}");
            let h12 = match hour % 12 {
                0 => 12,
                h => h,
            };
            let ampm = if hour < 12 { "AM" } else { "PM" };
            let label = format!("{h12}:{mins} {ampm}");
            (value, label)
        })
        .collect()
}

pub fn render_notifications(highlighted: Option<&str>, cx: &App) -> impl IntoElement {
    let store = cx.global::<SettingsStore>().clone();
    let hl_shared = highlighted.map(|s| SharedString::from(s.to_owned()));

    // Alerts group
    let alerts_group = SettingsGroup::new()
        .title("Alerts")
        .highlighted_row(hl_shared.clone())
        .row(
            CheckboxRow::new("notifications-notify-when-finished", "Notify when finished", store.notify_on_complete)
                .description("When a turn finishes or fails while you are outside the chat")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.notify_on_complete = next);
                }),
        )
        .row(
            CheckboxRow::new("notifications-dock-badge", "Dock badge", store.show_dock_badge)
                .description("Count chats with unread replies or waiting for your input")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.show_dock_badge = next);
                }),
        )
        .row(
            CheckboxRow::new("notifications-notify-when-waiting", "Notify when waiting", store.notify_on_attention)
                .description("When a chat needs an approval or an answer and Milagre is in the background")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.notify_on_attention = next);
                }),
        )
        .row(
            CheckboxRow::new("notifications-attention-button", "Attention button", store.show_attention_inbox)
                .description("Top right, when a chat in another project needs an approval or an answer")
                .highlighted(highlighted)
                .on_change(|next, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| s.show_attention_inbox = next);
                }),
        );

    // Schedule group
    let schedule_group = render_schedule_group(store.notification_schedule.as_ref(), highlighted, hl_shared.clone(), cx);

    // Sound group
    let chime_options = NOTIFICATION_CHIMES.iter().map(|&(id, label)| SelectOption::new(id, label));
    let chime_select = Select::new("notifications-chime", store.notification_chime.clone(), chime_options).on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| {
            s.notification_chime = val.to_string();
            s.last_played_chime = Some(val.to_string());
        });
    });

    let current_chime = store.notification_chime.clone();
    let play_button = Button::new("notifications-play-chime", "Play")
        .variant(ButtonVariant::Secondary)
        .size(ButtonSize::S28)
        .icon(IconName::VolumeHigh)
        .on_click(move |_, _, cx| {
            let chime = current_chime.clone();
            cx.update_global::<SettingsStore, _>(|s, _| s.last_played_chime = Some(chime));
        });

    let sound_controls = div().flex().items_center().gap(px(8.0)).child(play_button).child(chime_select);

    let sound_group = SettingsGroup::new().title("Sound").highlighted_row(hl_shared.clone()).row(
        SettingRow::new("Notification chime")
            .description("Plays when a Chat finishes or needs you. Picking one plays it.")
            .highlighted(highlighted)
            .control(sound_controls),
    );

    // Routines group
    let routines_group = SettingsGroup::new().title("Routines").highlighted_row(hl_shared).row(
        CheckboxRow::new("notifications-unread-runs-dot", "Unread Runs dot", store.show_unread_runs_dot)
            .description("On the Routines button and each Routine's row, while a Run's Chat has a result you haven't opened")
            .highlighted(highlighted)
            .on_change(|next, _, cx| {
                cx.update_global::<SettingsStore, _>(|s, _| s.show_unread_runs_dot = next);
            }),
    );

    div()
        .debug_selector(|| "settings-section-notifications".into())
        .flex()
        .flex_col()
        .child(page_header("Notifications", Some("How Milagre alerts you when chats finish or need input."), cx))
        .child(alerts_group)
        .child(schedule_group)
        .child(sound_group)
        .child(routines_group)
}

fn render_schedule_group(
    schedule: Option<&NotificationSchedule>,
    highlighted: Option<&str>,
    hl_shared: Option<SharedString>,
    cx: &App,
) -> SettingsGroup {
    let theme = *cx.theme();
    let mode_val = if schedule.is_some() { "custom" } else { "always" };
    let mode_select = Select::new(
        "notifications-schedule-mode",
        mode_val,
        [SelectOption::new("always", "Anytime"), SelectOption::new("custom", "Custom schedule")],
    )
    .on_change(|val, _, cx| {
        cx.update_global::<SettingsStore, _>(|s, _| {
            if val == "custom" {
                if s.notification_schedule.is_none() {
                    s.notification_schedule = Some(NotificationSchedule::work_hours());
                }
            } else {
                s.notification_schedule = None;
            }
        });
    });

    let mut row_col = div()
        .debug_selector(move || {
            if highlighted == Some("Notification schedule") {
                "settings-found-row".to_string()
            } else {
                "settings-row-notification-schedule".to_string()
            }
        })
        .px(px(16.0))
        .py(px(12.0))
        .when(highlighted == Some("Notification schedule"), |d| d.bg(theme.hover2))
        .flex()
        .flex_col()
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(16.0))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Notification schedule"),
                        )
                        .child(
                            div()
                                .mt(px(2.0))
                                .text_step(TEXT_12)
                                .text_color(theme.ink3)
                                .child("Quiet outside these hours. Unread Chats stay in your inbox."),
                        ),
                )
                .child(div().flex_shrink_0().child(mode_select)),
        );

    if let Some(sched) = schedule {
        let mut days_row = div().flex().flex_wrap().gap(px(6.0));
        for (day_ix, &label) in NOTIFICATION_DAYS.iter().enumerate() {
            let day_u8 = day_ix as u8;
            let active = sched.days.contains(&day_u8);
            let btn_id = format!("notifications-day-{}", label.to_ascii_lowercase());
            let btn = div()
                .id(ElementId::Name(SharedString::from(btn_id.clone())))
                .debug_selector(move || btn_id.clone())
                .h(CONTROL_SM)
                .min_w(px(40.0))
                .px(px(10.0))
                .rounded(RADIUS_CONTROL)
                .when(!active, |d| d.border_1().border_color(theme.line_strong))
                .bg(if active { theme.accent } else { theme.surface })
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active { theme.on_accent } else { theme.ink2 })
                .cursor_pointer()
                .flex()
                .items_center()
                .justify_center()
                .hover(move |s| if active { s } else { s.bg(theme.hover).text_color(theme.ink) })
                .on_click(move |_, _, cx| {
                    cx.update_global::<SettingsStore, _>(|s, _| {
                        if let Some(sc) = &mut s.notification_schedule {
                            if sc.days.contains(&day_u8) {
                                if sc.days.len() > 1 {
                                    sc.days.retain(|&d| d != day_u8);
                                }
                            } else {
                                sc.days.push(day_u8);
                                sc.days.sort_unstable();
                            }
                        }
                    });
                })
                .child(label);
            days_row = days_row.child(btn);
        }

        let times = notification_times();
        let current_end = sched.end.clone();
        let start_options = times.iter().map(|(val, label)| SelectOption::new(val.clone(), label.clone()).disabled(val == &current_end));
        let start_select = Select::new("notifications-schedule-start", sched.start.clone(), start_options).on_change(|val, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| {
                if let Some(sc) = &mut s.notification_schedule
                    && val.as_ref() != sc.end.as_str()
                {
                    sc.start = val.to_string();
                }
            });
        });

        let current_start = sched.start.clone();
        let end_options = times.iter().map(|(val, label)| SelectOption::new(val.clone(), label.clone()).disabled(val == &current_start));
        let end_select = Select::new("notifications-schedule-end", sched.end.clone(), end_options).on_change(|val, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| {
                if let Some(sc) = &mut s.notification_schedule
                    && val.as_ref() != sc.start.as_str()
                {
                    sc.end = val.to_string();
                }
            });
        });

        let tz_options = NOTIFICATION_TIME_ZONES.iter().map(|&tz| SelectOption::new(tz, tz));
        let tz_select = Select::new("notifications-schedule-tz", sched.time_zone.clone(), tz_options).on_change(|val, _, cx| {
            cx.update_global::<SettingsStore, _>(|s, _| {
                if let Some(sc) = &mut s.notification_schedule {
                    sc.time_zone = val.to_string();
                }
            });
        });

        let times_row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.0))
            .text_step(TEXT_12)
            .text_color(theme.ink3)
            .child("From")
            .child(start_select)
            .child("to")
            .child(end_select)
            .child(tz_select);

        row_col = row_col.child(
            div()
                .mt(px(12.0))
                .pt(px(12.0))
                .border_t_1()
                .border_color(theme.line)
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(days_row)
                .child(times_row),
        );
    }

    SettingsGroup::new().title("Schedule").highlighted_row(hl_shared).row(row_col)
}

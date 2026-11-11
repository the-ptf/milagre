//! A paired computer's page (`ComputerSettings` in `Settings.tsx`, `settings/HostUpdateRow.tsx`, `AutoUpdateRow`):
//! its name on this Mac, whether the sidebar shows it, how it is reached, what lives there (Projects, memory and disk,
//! the desktop app's update, Auto update) and Remove.
//!
//! Not built: the "MCP servers" section of an online computer (it is the Settings › MCP page pointed at that computer's
//! bridge; `src/settings/mcp/` owns it).

use std::time::Duration;

use gpui::{AnyElement, Context, IntoElement, ParentElement, Styled, Window, div, prelude::*, px};

use super::logic::{
    AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE, ComputerView, HostUpdate, Reach, UpdateStatus, computer_status_line, install_question, lan_state,
    paired_date, relay_state, route_line, seen_ago, update_available, update_busy, update_description,
};
use super::model::{DevicesStore, now_ms};
use super::resources::ResourceRow;
use super::view::DevicesView;
use super::widgets::{route_pill, row_error};
use crate::settings::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use crate::theme::{ActiveTheme, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Input};

fn update(cx: &mut gpui::App, f: impl FnOnce(&mut DevicesStore)) {
    cx.update_global::<DevicesStore, _>(|store, _| f(store));
}

impl DevicesView {
    /// Enter or blur in the Name field: a new name is kept, an empty or unchanged one puts the saved one back.
    fn commit_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((id, input)) = self.name.clone() else { return };
        let typed = input.read(cx).value().to_string();
        let mut renamed = false;
        update(cx, |s| renamed = s.rename_computer(&id, &typed));
        if !renamed && let Some(computer) = cx.global::<DevicesStore>().computer(&id).cloned() {
            input.update(cx, |state, cx| state.set_value(computer.name, window, cx));
        }
        cx.notify();
    }

    pub(super) fn computer_page(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let store = cx.global::<DevicesStore>().clone();
        let theme = *cx.theme();
        let Some(computer) = store.computer(id).cloned() else {
            return div().mt(px(24.0)).text_step(TEXT_13).text_color(theme.ink3).child("This computer was removed.").into_any_element();
        };
        let now = now_ms();
        let meta = store.meta.get(id).cloned();
        let online = computer.state == Reach::Online;
        let found = self.found.clone();
        let found = found.as_deref();

        // The Name field is made once per computer and shows its name.
        if self.name.as_ref().map(|(known, _)| known.as_str()) != Some(id) {
            let input = self.field("Name", false, window, cx, Some(Self::commit_name));
            input.update(cx, |state, cx| state.set_value(computer.name.clone(), window, cx));
            self.name = Some((id.to_string(), input));
        }
        let name_input = self.name.as_ref().map(|(_, input)| input.clone()).expect("made above");

        let status = computer_status_line(
            &computer,
            meta.as_ref().and_then(|m| m.version.as_deref()),
            computer.added_at.map(paired_date).as_deref(),
            now,
        );

        let general = SettingsGroup::new()
            .title("General")
            .row(
                SettingRow::new("Name")
                    .description("Shown on its chats in the sidebar. Only on This Mac.")
                    .highlighted(found)
                    .control(div().w(px(220.0)).child(Input::new("computer-name", &name_input))),
            )
            .row(
                CheckboxRow::new("computer-show", "Show in sidebar", !store.hidden_computers.contains(id))
                    .description(format!("{}'s Projects in the sidebar on This Mac. It stays connected while hidden.", computer.name))
                    .highlighted(found)
                    .on_change({
                        let id = id.to_string();
                        move |show, _, cx| {
                            let id = id.clone();
                            update(cx, |s| s.set_computer_hidden(&id, !show));
                        }
                    }),
            );

        let lan_description = match computer.lan_routes.first() {
            Some(route) => format!("{route}, end-to-end encrypted"),
            None => "Not reached on a shared network yet".to_string(),
        };
        let connection = SettingsGroup::new()
            .title("Connection")
            .row(SettingRow::new("Same network").description(lan_description).control(route_pill(lan_state(&computer), cx)))
            .row(
                SettingRow::new("Relay")
                    .description(format!("{}, used away from that network", computer.relay_host))
                    .control(route_pill(relay_state(&computer), cx)),
            );

        // On this computer.
        let projects = meta.as_ref().map(|m| m.projects.clone()).unwrap_or_default();
        let mut on_rows: Vec<AnyElement> = Vec::new();
        on_rows.push(if online {
            let label = format!("{} {}", projects.len(), if projects.len() == 1 { "Project" } else { "Projects" });
            let names = if projects.is_empty() { String::new() } else { format!("{}. ", projects.join(", ")) };
            div()
                .debug_selector(|| "computer-projects".into())
                .child(SettingRow::new(label).description(format!("{names}Accounts and simulators stay on {}.", computer.name)))
                .into_any_element()
        } else {
            let mut row = SettingRow::new(format!("{} is offline", computer.name));
            if let Some(ago) = seen_ago(computer.last_seen, now) {
                row = row.description(format!("Last seen {ago}."));
            }
            div().debug_selector(|| "computer-projects".into()).child(row).into_any_element()
        });
        let resource = ResourceRow {
            id: computer.id.clone(),
            name: computer.name.clone(),
            detail: if online { route_line(&computer, now) } else { "Offline".into() },
            online,
            seen: seen_ago(computer.last_seen, now).map(|ago| format!("Seen {ago}")),
        };
        on_rows.extend(self.resource_rows(std::slice::from_ref(&resource), &store, cx));
        if online && let Some(host) = meta.as_ref().and_then(|m| m.update.clone()) {
            on_rows.push(self.host_update_row(id, &computer, &host, cx));
        }
        if online && let Some(meta) = &meta {
            let id = id.to_string();
            on_rows.push(
                div()
                    .debug_selector(|| "computer-auto-update".into())
                    .child(
                        CheckboxRow::new("computer-auto-update", AUTO_UPDATE_TITLE, meta.auto_update)
                            .description(AUTO_UPDATE_HINT)
                            .on_change(move |on, _, cx| {
                                let id = id.clone();
                                update(cx, |s| s.set_auto_update(&id, on));
                            }),
                    )
                    .into_any_element(),
            );
        }
        let on_group = SettingsGroup::new().title(format!("On {}", computer.name)).rows(on_rows);

        // Remove.
        let waiting = store.waiting.get(id).copied().unwrap_or(0);
        let mut remove_text = format!(
            "Its Chats leave this sidebar and This Mac forgets its keys. Nothing changes on {}; pair again with a new link.",
            computer.name
        );
        if waiting > 0 {
            remove_text.push_str(&format!(
                " {} waiting on This Mac for it will be discarded.",
                if waiting == 1 { "1 message".to_string() } else { format!("{waiting} messages") }
            ));
        }
        let remove_control: AnyElement = if self.confirm_remove {
            let remove_id = id.to_string();
            div()
                .flex()
                .gap(px(8.0))
                .child(Button::new("computer-remove-cancel", "Cancel").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.confirm_remove = false;
                        cx.notify();
                    }),
                ))
                .child(
                    Button::new("computer-remove-confirm", format!("Remove {}", computer.name))
                        .variant(ButtonVariant::DangerGhost)
                        .size(ButtonSize::S28)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.confirm_remove = false;
                            let id = remove_id.clone();
                            update(cx, |s| s.remove_computer(&id));
                            cx.notify();
                        })),
                )
                .into_any_element()
        } else {
            Button::new("computer-remove", "Remove")
                .variant(ButtonVariant::DangerGhost)
                .size(ButtonSize::S28)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.confirm_remove = true;
                    cx.notify();
                }))
                .into_any_element()
        };

        div()
            .debug_selector(|| "computer-settings".into())
            .flex()
            .flex_col()
            .child(page_header(computer.name.clone(), Some(&status), cx))
            .child(general)
            .child(connection)
            .child(on_group)
            .when(!self.error.is_empty(), |d| d.child(row_error(self.error.clone(), cx)))
            .child(
                SettingsGroup::new()
                    .title("Remove")
                    .row(SettingRow::new(format!("Remove {}", computer.name)).description(remove_text).control(remove_control)),
            )
            .into_any_element()
    }

    /// `HostUpdateRow`: Check for updates, or Install & restart after a question.
    fn host_update_row(&mut self, id: &str, computer: &ComputerView, host: &HostUpdate, cx: &mut Context<Self>) -> AnyElement {
        let name = computer.name.clone();
        let restarting = host.status == UpdateStatus::Installing;
        let label = update_available(host).unwrap_or_else(|| "Updates".to_string());
        let (title, message, action) = install_question(&name, host.version.as_deref());
        let description = if self.update_confirming {
            format!("{title} {message}")
        } else {
            format!("{} runs Milagre {}. {}", name, host.current, update_description(host))
        };
        let control: AnyElement = if self.update_confirming {
            let install_id = id.to_string();
            div()
                .flex()
                .gap(px(8.0))
                .child(Button::new("computer-update-cancel", "Cancel").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.update_confirming = false;
                        cx.notify();
                    }),
                ))
                .child(Button::new("computer-update-confirm", action).variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                    cx.listener(move |this, _, window, cx| {
                        this.update_confirming = false;
                        let id = install_id.clone();
                        update(cx, |s| s.install_host_update(&id));
                        window
                            .spawn(cx, async move |cx| {
                                cx.background_executor().timer(Duration::from_millis(1800)).await;
                                cx.update(|_, cx| {
                                    update(cx, |s| {
                                        if let Some(u) = s.meta.get_mut(&id).and_then(|m| m.update.as_mut()) {
                                            u.status = UpdateStatus::UpToDate;
                                            if let Some(version) = u.version.clone() {
                                                u.current = version;
                                            }
                                        }
                                    })
                                })
                                .ok();
                            })
                            .detach();
                        cx.notify();
                    }),
                ))
                .into_any_element()
        } else if host.status == UpdateStatus::Downloaded {
            Button::new("computer-update-install", "Install & restart")
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::S28)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.update_confirming = true;
                    cx.notify();
                }))
                .into_any_element()
        } else {
            let check_id = id.to_string();
            Button::new("computer-update-check", if restarting { "Restarting\u{2026}" } else { "Check for updates" })
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::S28)
                .disabled(update_busy(host))
                .on_click(move |_, window, cx| {
                    let id = check_id.clone();
                    update(cx, |s| s.check_host_update(&id));
                    window
                        .spawn(cx, async move |cx| {
                            cx.background_executor().timer(Duration::from_millis(1200)).await;
                            cx.update(|_, cx| update(cx, |s| s.host_update_found(&id))).ok();
                        })
                        .detach();
                })
                .into_any_element()
        };
        div()
            .debug_selector(|| "computer-update".into())
            .child(SettingRow::new(label).description(description).control(control))
            .into_any_element()
    }
}

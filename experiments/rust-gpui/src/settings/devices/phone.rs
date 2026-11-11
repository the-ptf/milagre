//! Settings › Phone & sharing (`DevicesSettings`, `PhoneSharingPage`, `SimlockSettings`, `PublishedPagesSettings` in
//! `Settings.tsx` and `settings/SimlockSettings.tsx`): device access and the pairing code, the paired computers and
//! phones, Reset access, Simlock simulators and the published pages.

use std::time::Duration;

use gpui::{
    AnyElement, ClipboardItem, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::*, px,
};

use super::logic::{
    DeviceKind, PairedDevice, PhoneState, Remote, cloudflare_phones_note, device_name, device_seen_line, devices_by_kind, pairing_line,
    pairing_window, phone_lan_line, phone_status_line, remove_device_question,
};
use super::model::{DevicesStore, now_ms};
use super::qr::qr_code;
use super::view::{DevicesView, lit, open_link};
use super::widgets::{card_note, icon_chip};
use crate::settings::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Dialog, DialogAction, IconName, Select, SelectOption};

const PRIVACY_URL: &str = "https://milagre.cloud/privacy";
const SUPPORT_URL: &str = "https://milagre.cloud/support";
const SIMLOCK_URL: &str = "https://github.com/callstackincubator/simlock";
const MAX_LEASES: [u32; 6] = [1, 2, 3, 4, 6, 8];
const LEASE_MINUTES: [u32; 5] = [15, 30, 60, 120, 240];

fn update(cx: &mut gpui::App, f: impl FnOnce(&mut DevicesStore)) {
    cx.update_global::<DevicesStore, _>(|store, _| f(store));
}

impl DevicesView {
    pub(super) fn devices_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let store = cx.global::<DevicesStore>().clone();
        let theme = *cx.theme();
        let now = now_ms();
        let found = self.found.clone();
        let found = found.as_deref();
        let status = &store.phone;
        let on = status.state == PhoneState::On && !status.pairing_link.is_empty();

        // Access.
        let mut access: Vec<AnyElement> = vec![
            CheckboxRow::new("devices-allow", "Allow devices to connect", status.enabled)
                .description(phone_status_line(Some(status)))
                .highlighted(found)
                .on_change(|next, _, cx| update(cx, |s| s.set_phone_enabled(next)))
                .into_any_element(),
        ];
        if let (true, Some(lan)) = (status.enabled, status.lan.as_ref()) {
            access.push(
                CheckboxRow::new("devices-lan", "Allow on local network", lan.enabled)
                    .description(phone_lan_line(status).unwrap_or_default())
                    .highlighted(found)
                    .on_change(|next, _, cx| update(cx, |s| s.set_lan(next)))
                    .into_any_element(),
            );
        }
        if status.state == PhoneState::On && status.remote == Remote::None {
            access.push(
                card_note(
                    "Only a phone simulator on This Mac can connect. Set up a Cloudflare tunnel with npm run mobile:cloudflare to reach This Mac from any network.",
                    cx,
                )
                .debug_selector(|| "phone-local-only".into())
                .into_any_element(),
            );
        }
        if let (PhoneState::Error, Some(error)) = (status.state, &status.error) {
            access.push(card_note(error.clone(), cx).text_color(theme.red_ink).into_any_element());
        }

        // The code.
        let mut code: Vec<AnyElement> = Vec::new();
        if on {
            if status.pairing_options.len() > 1 {
                let options: Vec<SelectOption> =
                    status.pairing_options.iter().map(|o| SelectOption::new(o.id.clone(), o.label.clone())).collect();
                code.push(
                    SettingRow::new("Connect through")
                        .description("Automatic tries LAN and Tailscale before the remote connection. Private pairing needs both devices on the same network or tailnet.")
                        .highlighted(found)
                        .control(
                            Select::new("devices-pairing-route", store.pairing_route.clone(), options)
                                .width(180.0)
                                .on_change(|value, _, cx| {
                                    let value = value.to_string();
                                    update(cx, |s| s.pairing_route = value);
                                }),
                        )
                        .into_any_element(),
                );
            }
            code.push(self.qr_block(&store, now, cx));
        }

        // Paired devices.
        let (computers, phones) = devices_by_kind(&store.devices);
        let mut lists: Vec<AnyElement> = Vec::new();
        if !computers.is_empty() {
            lists.push(self.device_group(&computers, &store, now, None, None, cx));
        }
        lists.push(self.device_group(&phones, &store, now, Some("No phones yet"), cloudflare_phones_note(status).map(str::to_string), cx));

        // Reset.
        let reset = status.enabled.then(|| {
            let busy = status.state == PhoneState::Starting;
            let control: AnyElement = if self.confirm_reset {
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(Button::new("devices-reset-cancel", "Cancel").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.confirm_reset = false;
                            cx.notify();
                        }),
                    ))
                    .child(
                        Button::new("devices-reset-confirm", "Reset and disconnect")
                            .variant(ButtonVariant::DangerGhost)
                            .size(ButtonSize::S28)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.confirm_reset = false;
                                update(cx, |s| s.reset_access());
                                cx.notify();
                            })),
                    )
                    .into_any_element()
            } else {
                Button::new("devices-reset", "Reset access")
                    .variant(ButtonVariant::Secondary)
                    .size(ButtonSize::S28)
                    .disabled(busy)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.confirm_reset = true;
                        cx.notify();
                    }))
                    .into_any_element()
            };
            SettingsGroup::new().row(
                SettingRow::new("Reset access")
                    .description(if self.confirm_reset {
                        "Devices that already paired stop working and must pair again. This can't be undone."
                    } else {
                        "Make a new code. Devices that already paired pair again."
                    })
                    .highlighted(found)
                    .control(control),
            )
        });

        div()
            .flex()
            .flex_col()
            .child(page_header(
                "Phone & sharing",
                Some("Phones and other computers that can see and drive This Mac's chats, and what you share."),
                cx,
            ))
            .child(SettingsGroup::new().rows(access))
            .when(!code.is_empty(), |d| d.child(SettingsGroup::new().rows(code)))
            .children(lists)
            .when_some(reset, |d, group| d.child(group))
            .child(self.simlock_group(&store, found, window, cx))
            .child(self.published_group(found))
            .into_any_element()
    }

    fn qr_block(&mut self, store: &DevicesStore, now: i64, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let found = self.found.clone();
        let found = found.as_deref();
        let link = store.phone.pairing_link.clone();
        let window_state = pairing_window(&store.phone, now);
        let copied = store.copied;
        let copy_link = link.clone();
        let copy = Button::new("devices-copy-link", if copied { "Copied" } else { "Copy link" })
            .variant(ButtonVariant::Secondary)
            .size(ButtonSize::S28)
            .on_click(cx.listener(move |_, _, window, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(copy_link.clone()));
                update(cx, |s| s.copied = true);
                window
                    .spawn(cx, async move |cx| {
                        cx.background_executor().timer(Duration::from_millis(1600)).await;
                        cx.update(|_, cx| update(cx, |s| s.copied = false)).ok();
                    })
                    .detach();
            }));
        let link_text = |id: &'static str, label: &'static str, url: &'static str| {
            div()
                .id(id)
                .cursor_pointer()
                .underline()
                .text_step(TEXT_12)
                .text_color(theme.ink)
                .on_click(move |_, _, cx| open_link(url, cx))
                .child(label)
        };
        let pairing_row = window_state.map(|w| {
            div()
                .debug_selector(move || if w.open { "phone-pairing-open".into() } else { "phone-pairing-closed".into() })
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.0))
                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(pairing_line(w)))
                .when(!w.open, |d| {
                    d.child(lit(
                        Button::new("devices-allow-pairing", "Allow pairing again")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .on_click(|_, _, cx| update(cx, |s| s.allow_pairing_again())),
                        found,
                        "Allow pairing again",
                        cx,
                    ))
                })
        });
        div()
            .debug_selector(|| "phone-qr-block".into())
            .flex()
            .items_start()
            .gap(px(20.0))
            .px(px(16.0))
            .py(px(16.0))
            .child(qr_code(&link, 176.0))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(lit(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(
                                div()
                                    .text_step(TEXT_13)
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.ink)
                                    .child("Scan with the Milagre app"),
                            )
                            .child(
                                div()
                                    .text_step(TEXT_12)
                                    .text_color(theme.ink3)
                                    .child("Open the app on your phone and point its camera at this code."),
                            ),
                        found,
                        "Scan with the Milagre app",
                        cx,
                    ))
                    .child(div().flex().child(lit(copy, found, "Copy link", cx)))
                    .child(
                        div()
                            .text_step(TEXT_12)
                            .text_color(theme.ink2)
                            .child("This code gives access to your agents. Don't share it or post a screenshot of it."),
                    )
                    .child(div().flex().gap(px(16.0)).child(link_text("devices-privacy", "Privacy policy", PRIVACY_URL)).child(link_text(
                        "devices-support",
                        "Support",
                        SUPPORT_URL,
                    )))
                    .children(pairing_row),
            )
            .into_any_element()
    }

    /// `DeviceGroup`: a card of paired devices, a row each, with Remove asking a second click.
    fn device_group(
        &mut self,
        devices: &[PairedDevice],
        store: &DevicesStore,
        now: i64,
        empty: Option<&str>,
        footer: Option<String>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = *cx.theme();
        let mut rows: Vec<AnyElement> = Vec::new();
        if devices.is_empty()
            && let Some(empty) = empty
        {
            rows.push(card_note(empty, cx).debug_selector(|| "devices-empty".into()).into_any_element());
        }
        for device in devices {
            let asking = self.confirming_device.as_deref() == Some(device.key.as_str());
            let key = device.key.clone();
            let icon = if device.kind == DeviceKind::Computer { IconName::Laptop } else { IconName::Smartphone };
            let dot = if device.route.is_some() { theme.green } else { theme.ink3 };
            let line = if asking { remove_device_question(device) } else { device_seen_line(device, now) };
            let fresh = store.fresh.contains(&device.key);
            let control: AnyElement = if asking {
                let confirm_key = key.clone();
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        Button::new(SharedString::from(format!("device-cancel-{key}")), "Cancel")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.confirming_device = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("device-confirm-{key}")), "Remove")
                            .variant(ButtonVariant::DangerGhost)
                            .size(ButtonSize::S28)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.confirming_device = None;
                                let key = confirm_key.clone();
                                update(cx, |s| s.remove_device(&key));
                                cx.notify();
                            })),
                    )
                    .into_any_element()
            } else {
                let ask_key = key.clone();
                Button::new(SharedString::from(format!("device-remove-{key}")), "Remove")
                    .variant(ButtonVariant::DangerGhost)
                    .size(ButtonSize::S24)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.confirming_device = Some(ask_key.clone());
                        cx.notify();
                    }))
                    .into_any_element()
            };
            rows.push(
                div()
                    .debug_selector(move || format!("device-row-{key}"))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .min_h(px(48.0))
                    .px(px(16.0))
                    .py(px(8.0))
                    .child(
                        div().relative().child(icon_chip(icon, cx)).child(
                            div()
                                .absolute()
                                .right(px(-2.0))
                                .bottom(px(-2.0))
                                .size(px(10.0))
                                .rounded_full()
                                .border_2()
                                .border_color(theme.inset)
                                .bg(dot),
                        ),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_step(TEXT_13)
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(theme.ink)
                                            .child(device_name(device)),
                                    )
                                    .when(fresh, |d| {
                                        d.child(
                                            div()
                                                .debug_selector(|| "device-new".into())
                                                .flex_none()
                                                .rounded_full()
                                                .bg(theme.accent_tint)
                                                .px(px(6.0))
                                                .text_color(theme.accent_ink)
                                                .text_step(crate::theme::TEXT_10)
                                                .font_weight(FontWeight::SEMIBOLD)
                                                .child("New"),
                                        )
                                    }),
                            )
                            .child(div().text_step(TEXT_12).text_color(theme.ink3).child(line)),
                    )
                    .child(control)
                    .into_any_element(),
            );
        }
        if let Some(footer) = footer {
            rows.push(card_note(footer, cx).into_any_element());
        }
        SettingsGroup::new().rows(rows).into_any_element()
    }

    fn simlock_group(&mut self, store: &DevicesStore, found: Option<&str>, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let simlock = store.simlock.clone();
        let mut rows: Vec<AnyElement> = vec![
            CheckboxRow::new("simlock-enabled", "Simlock devices", simlock.enabled)
                .description("Agents lease a simulator or emulator of their own from a Simlock pool, watch it here and on the phone, and return it wiped. Simlock runs on your own Macs; Milagre doesn't install it.")
                .highlighted(found)
                .on_change(|next, _, cx| update(cx, |s| s.simlock.enabled = next))
                .into_any_element(),
        ];
        if simlock.enabled {
            let gateway = match &self.gateway {
                Some(input) => input.clone(),
                None => {
                    let placeholder = simlock.detected_gateway.clone().unwrap_or_else(|| "https://gateway.example.ts.net:4700".into());
                    let input = self.field(&placeholder, false, window, cx, None);
                    self.gateway = Some(input.clone());
                    input
                }
            };
            let token = match &self.token {
                Some(input) => input.clone(),
                None => {
                    let hint = if simlock.token_saved { "Saved" } else { "slk_..." };
                    let input = self.field(hint, true, window, cx, None);
                    self.token = Some(input.clone());
                    input
                }
            };
            let detected = match &simlock.detected_gateway {
                Some(url) => format!("this Mac's Simlock worker at {url}"),
                None => "a Simlock worker started on this Mac".to_string(),
            };
            let labelled = |title: &'static str, help: AnyElement, field: AnyElement| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(title))
                    .child(help)
                    .child(field)
            };
            let help = |text: String| div().text_step(TEXT_12).text_color(theme.ink3).child(text).into_any_element();
            let check_line = self.simlock_check.clone();
            let save_gateway = gateway.clone();
            let save_token = token.clone();
            let form = div()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .px(px(16.0))
                .child(labelled(
                    "Gateway",
                    help(format!("A Simlock gateway or worker's address. Leave it empty to use {detected}.")),
                    crate::ui::Input::new("simlock-gateway", &gateway).into_any_element(),
                ))
                .child(labelled(
                    "Agent token",
                    help("From simlock token create --role agent, one per Mac running Milagre. It stays on this Mac and goes only to its gateway.".into()),
                    crate::ui::Input::new("simlock-token", &token).into_any_element(),
                ))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            Button::new("simlock-save", "Save and check")
                                .variant(ButtonVariant::Secondary)
                                .size(ButtonSize::S28)
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    let gateway_text = save_gateway.read(cx).value().to_string();
                                    let token_text = save_token.read(cx).value().to_string();
                                    let mut text = String::new();
                                    update(cx, |s| text = s.save_simlock(&gateway_text, &token_text));
                                    this.simlock_check = Some((true, text));
                                    save_token.update(cx, |state, cx| state.set_value("", window, cx));
                                    cx.notify();
                                })),
                        )
                        .when(simlock.token_saved, |d| {
                            d.child(Button::new("simlock-forget", "Forget token").variant(ButtonVariant::Quiet).size(ButtonSize::S28).on_click(
                                cx.listener(|this, _, _, cx| {
                                    update(cx, |s| s.simlock.token_saved = false);
                                    this.simlock_check = None;
                                    cx.notify();
                                }),
                            ))
                        })
                        .child(
                            div()
                                .id("simlock-about")
                                .ml_auto()
                                .cursor_pointer()
                                .text_step(TEXT_12)
                                .text_color(theme.ink2)
                                .on_click(|_, _, cx| open_link(SIMLOCK_URL, cx))
                                .child("About Simlock"),
                        ),
                )
                .children(check_line.map(|(ok, text)| {
                    div().text_step(TEXT_12).text_color(if ok { theme.ink2 } else { theme.red_ink }).child(text)
                }));
            let leases: Vec<SelectOption> = MAX_LEASES.iter().map(|n| SelectOption::new(n.to_string(), n.to_string())).collect();
            let mut minutes: Vec<u32> = LEASE_MINUTES.to_vec();
            if !minutes.contains(&simlock.max_minutes) {
                minutes.push(simlock.max_minutes);
                minutes.sort_unstable();
            }
            let minute_options: Vec<SelectOption> = minutes
                .iter()
                .map(|m| SelectOption::new(m.to_string(), if *m < 60 { format!("{m} min") } else { format!("{} h", m / 60) }))
                .collect();
            let inner = div()
                .ml(px(16.0))
                .border_l_1()
                .border_color(theme.line)
                .pb(px(12.0))
                .flex()
                .flex_col()
                .gap(px(12.0))
                .child(form)
                .child(
                    SettingRow::new("Devices at once")
                        .description("Leases this Mac holds together. Simlock also caps leases per token (lease.maxPerRequester).")
                        .highlighted(found)
                        .control(Select::new("simlock-leases", simlock.max_leases.to_string(), leases).width(90.0).on_change(
                            |v, _, cx| {
                                let n = v.parse().unwrap_or(2);
                                update(cx, |s| s.simlock.max_leases = n);
                            },
                        )),
                )
                .child(
                    SettingRow::new("Return a device after")
                        .description("A lease ends this long after it started, even while an agent uses it.")
                        .highlighted(found)
                        .control(Select::new("simlock-minutes", simlock.max_minutes.to_string(), minute_options).width(120.0).on_change(
                            |v, _, cx| {
                                let n = v.parse().unwrap_or(60);
                                update(cx, |s| s.simlock.max_minutes = n);
                            },
                        )),
                );
            rows.push(inner.into_any_element());
        }
        SettingsGroup::new()
            .title("Simulators")
            .highlighted_row(found.map(|f| SharedString::from(f.to_string())))
            .rows(rows)
            .into_any_element()
    }

    fn published_group(&mut self, found: Option<&str>) -> AnyElement {
        let manage = Button::new("devices-published-manage", "Manage").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
            |_, window, cx| {
                Dialog::new("Published pages")
                    .description("Public links to designs and artifacts this computer published, including pages from deleted Chats.")
                    .width(520.0)
                    .body(|_, cx| {
                        let theme = *cx.theme();
                        let page = |title: &'static str, link: &'static str| {
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .px(px(12.0))
                                .py(px(8.0))
                                .child(div().text_step(TEXT_13).text_color(theme.ink).child(title))
                                .child(div().text_step(TEXT_12).text_color(theme.ink3).child(link))
                        };
                        div()
                            .mt(px(4.0))
                            .rounded(RADIUS_CONTROL)
                            .border_1()
                            .border_color(theme.line)
                            .flex()
                            .flex_col()
                            .child(page("Settings redesign", "https://share.milagre.cloud/p/9fK2xQ"))
                            .child(div().h(px(1.0)).bg(theme.line))
                            .child(page("Sidebar sketch", "https://share.milagre.cloud/p/Ab31Zm"))
                            .into_any_element()
                    })
                    .action(DialogAction::new("published-close", "Done").variant(ButtonVariant::Secondary))
                    .open(window, cx);
            },
        );
        SettingsGroup::new()
            .title("Designs and artifacts")
            .highlighted_row(found.map(|f| SharedString::from(f.to_string())))
            .row(
                SettingRow::new("Published pages")
                    .description("Manage public links to designs and artifacts, including pages from deleted Chats.")
                    .highlighted(found)
                    .control(manage),
            )
            .into_any_element()
    }
}

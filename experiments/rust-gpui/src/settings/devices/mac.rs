//! Settings › This Mac (`ThisMacPage`, `DeviceResources`, `OtherComputersSetting` in `Settings.tsx`) and its
//! Computer use sub-page (`settings/ComputerUseSettings.tsx`): memory and disk on this Mac and on every computer it
//! drives, the switch for driving other computers, and agents operating apps on this computer.

use gpui::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString, StatefulInteractiveElement, Styled,
    Window, div, prelude::*, px,
};

use super::logic::{Permission, permission_missing, route_line};
use super::model::{DevicesStore, now_ms};
use super::resources::ResourceRow;
use super::view::{DevicesView, MacPage, lit, open_link};
use super::widgets::{group_footer, hover_half_color};
use crate::settings::group::{CheckboxRow, SettingRow, SettingsGroup, page_header};
use crate::settings::search::SettingsSectionId as S;
use crate::theme::{ActiveTheme, TEXT_12, TEXT_13, TEXT_17, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconButton, IconButtonSize, IconName, IconSize};
use crate::workspace::preview::settings_row_shows;

const AGENT_DESKTOP_URL: &str = "https://github.com/vercel-labs/agent-desktop";

fn update(cx: &mut gpui::App, f: impl FnOnce(&mut DevicesStore)) {
    cx.update_global::<DevicesStore, _>(|store, _| f(store));
}

impl DevicesView {
    pub(super) fn this_mac_page(&mut self, name: &str, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let store = cx.global::<DevicesStore>().clone();
        let title = if name.trim().is_empty() { store.this_mac.clone() } else { name.to_string() };
        if self.mac_page == MacPage::ComputerUse {
            return self.computer_use_page(&title, &store, cx);
        }
        let theme = *cx.theme();
        let now = now_ms();
        let found = self.found.clone();
        let found = found.as_deref();

        let mut rows =
            vec![ResourceRow { id: "this-mac".into(), name: title.clone(), detail: "This Mac".into(), online: true, seen: None }];
        // A data layer reads this computer's memory and disk only; its paired computers' are theirs to read.
        if store.other_computers && !store.hosted.on {
            rows.extend(store.computers.iter().map(|c| ResourceRow {
                id: c.id.clone(),
                name: c.name.clone(),
                detail: if c.state == super::logic::Reach::Online { route_line(c, now) } else { "Offline".into() },
                online: c.state == super::logic::Reach::Online,
                seen: super::logic::seen_ago(c.last_seen, now).map(|ago| format!("Seen {ago}")),
            }));
        }
        let resource_rows = self.resource_rows(&rows, &store, cx);

        let mut drive = vec![
            CheckboxRow::new("mac-drive-other", "Drive other computers", store.other_computers)
                .description("Drive the chats of other computers running Milagre from this window. Their Projects join the sidebar.")
                .highlighted(found)
                .on_change(|next, _, cx| update(cx, |s| s.other_computers = next))
                .into_any_element(),
        ];
        if store.other_computers {
            drive.push(
                SettingRow::new("Add computer")
                    .description("Pair with another computer using the link from its Settings \u{203a} Phone & sharing. The laptop button in the sidebar adds one too.")
                    .highlighted(found)
                    .control(
                        Button::new("mac-add-computer", "Add computer\u{2026}").variant(ButtonVariant::Secondary).size(ButtonSize::S28).on_click(
                            |_, _, cx| update(cx, |s| s.add_computer_requests += 1),
                        ),
                    )
                    .into_any_element(),
            );
        }

        let on = store.computer_use.enabled;
        let computer_use_row = div()
            .id("computer-use-row")
            .debug_selector(|| "computer-use-row".into())
            .flex()
            .items_center()
            .justify_between()
            .gap(px(24.0))
            .min_h(px(48.0))
            .px(px(16.0))
            .py(px(8.0))
            .cursor_pointer()
            .hover(move |s| s.bg(theme.hover))
            .on_click(cx.listener(|this, _, _, cx| {
                this.mac_page = MacPage::ComputerUse;
                cx.notify();
            }))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child("Computer use"))
                    .child(
                        div()
                            .text_step(TEXT_12)
                            .text_color(theme.ink3)
                            .child("Agents see and operate apps on this computer, asking before each new app."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.0))
                    .text_step(TEXT_13)
                    .text_color(theme.ink2)
                    .child(if on { "On" } else { "Off" })
                    .child(Icon::new(IconName::ArrowRight01).size(IconSize::S16).color(theme.ink3)),
            );

        div()
            .debug_selector(|| "this-mac-settings".into())
            .flex()
            .flex_col()
            .child(page_header(title, None, cx))
            .child(SettingsGroup::new().rows(resource_rows))
            // A data layer lists only what it backs (`preview::settings_row_shows`).
            .when(settings_row_shows(cx, S::ThisMac, "Drive other computers"), |d| d.child(SettingsGroup::new().rows(drive)))
            .when(settings_row_shows(cx, S::ThisMac, "Automation"), |d| {
                d.child(
                    SettingsGroup::new().title("Automation").highlighted_row(found.map(|f| SharedString::from(f.to_string()))).row(lit(
                        computer_use_row,
                        found,
                        "Computer use",
                        cx,
                    )),
                )
            })
            .into_any_element()
    }

    fn computer_use_page(&mut self, parent: &str, store: &DevicesStore, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let cu = store.computer_use.clone();
        let on = cu.enabled && cu.supported;
        let header = div()
            .mb(px(20.0))
            .flex()
            .items_center()
            .gap(px(12.0))
            .child(IconButton::new("computer-use-back", IconName::ArrowLeft01).size(IconButtonSize::S28).on_click(cx.listener(
                |this, _, _, cx| {
                    this.mac_page = MacPage::Main;
                    cx.notify();
                },
            )))
            .child(
                div()
                    .flex()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.0))
                    .text_step(TEXT_17)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(div().text_color(theme.ink3).child(parent.to_string()))
                    .child(Icon::new(IconName::ArrowRight01).size(IconSize::S16).color(theme.ink3))
                    .child(div().text_color(theme.ink).child("Computer use")),
            );

        let mut first = vec![
            CheckboxRow::new("cu-enabled", "Computer use", cu.enabled)
                .description("Agents can see and operate apps on this computer. They ask before each new app, and never move your pointer or take focus.")
                .disabled(!cu.supported)
                .on_change(|next, _, cx| update(cx, |s| s.computer_use.enabled = next))
                .into_any_element(),
        ];
        if on {
            first.push(
                CheckboxRow::new("cu-cursor", "Show the agent's cursor", cu.cursor)
                    .description(
                        "Draw Milagre's cursor and the current step on the screen while an agent acts. Your own pointer never moves.",
                    )
                    .on_change(|next, _, cx| update(cx, |s| s.computer_use.cursor = next))
                    .into_any_element(),
            );
        }
        let permission = |id: &'static str, label: &'static str, state: Permission| {
            let missing = permission_missing(state);
            div()
                .debug_selector(move || format!("cu-permission-{id}"))
                .flex()
                .items_center()
                .gap(px(10.0))
                .min_h(px(48.0))
                .px(px(16.0))
                .py(px(8.0))
                .child(
                    Icon::new(if missing { IconName::AlertCircle } else { IconName::CheckmarkCircle02 })
                        .size(IconSize::S16)
                        .color(if missing { theme.orange_ink } else { theme.green_ink }),
                )
                .child(div().min_w_0().flex_1().text_step(TEXT_13).text_color(theme.ink).child(label))
                .child(if missing {
                    Button::new(SharedString::from(format!("cu-grant-{id}")), "Grant")
                        .variant(ButtonVariant::Secondary)
                        .size(ButtonSize::S28)
                        .on_click(|_, _, cx| update(cx, |s| s.grant_permissions()))
                        .into_any_element()
                } else {
                    div().text_step(TEXT_12).text_color(theme.ink3).child("Granted").into_any_element()
                })
                .into_any_element()
        };
        div()
            .debug_selector(|| "computer-use-page".into())
            .flex()
            .flex_col()
            .child(header)
            .child(SettingsGroup::new().rows(first))
            .when(!cu.supported, |d| d.child(group_footer("Not available on this computer.", cx)))
            .when(on, |d| {
                d.child(SettingsGroup::new().title("Permissions").rows([
                    permission("accessibility", "Accessibility, to read and operate apps", cu.accessibility),
                    permission("screen-recording", "Screen Recording, for the live screen in Chats", cu.screen_recording),
                ]))
                .child(group_footer(
                    "macOS grants these to Milagre, the app that runs agent-desktop. Grant opens System Settings at the missing one.",
                    cx,
                ))
                .child(
                    SettingsGroup::new()
                        .title("Never used by agents")
                        .row(div().px(px(16.0)).py(px(12.0)).text_step(TEXT_13).text_color(theme.ink2).child(cu.blocked_apps.join(", "))),
                )
                .child(group_footer(
                    format!("Uses agent-desktop {} by Vercel Labs. Apps you allow stay allowed only in that Chat.", cu.version),
                    cx,
                ))
                .child(
                    div()
                        .id("cu-about")
                        .cursor_pointer()
                        .px(px(4.0))
                        .text_step(TEXT_12)
                        .text_color(theme.ink2)
                        .hover(move |s| s.bg(hover_half_color(&theme)))
                        .on_click(|_, _, cx| open_link(AGENT_DESKTOP_URL, cx))
                        .child("About agent-desktop"),
                )
            })
            .into_any_element()
    }
}

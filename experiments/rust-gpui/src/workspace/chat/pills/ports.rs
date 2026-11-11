//! The Ports pill and panel (`PortTrack.tsx`): a "Ports n" pill that grows into the list of ports the Chat's
//! commands listen on. A row opens the port (the browser is another package, so it only closes the panel and is
//! recorded for the tests); its stop button ends the command behind it, with a spinner until the call returns.

use gpui::{AnyElement, ClickEvent, Context, ElementId, IntoElement, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::data::PortRow;
use super::{PANEL_PAD, PillRow, scroll_body};
use crate::theme::{ActiveTheme, RADIUS_CHIP, RADIUS_CONTROL, TEXT_13, TextStepExt, Theme, mono};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, SpinnerRing, StatusPill};

const ROW_HEIGHT: f32 = 34.0;
const STOP_ALL: f32 = 44.0;

impl PillRow {
    pub(super) fn ports_pill(&self, cx: &mut Context<Self>) -> AnyElement {
        StatusPill::new("pill-ports-button")
            .icon(IconName::EthernetPort)
            .label("Ports")
            .count(self.data.ports.len() as u32)
            .bare()
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.set_open(Some(super::Kind::Ports), false, window, cx)))
            .into_any_element()
    }

    pub(super) fn ports_height(&self) -> f32 {
        let n = self.data.ports.len() as f32;
        2.0 * PANEL_PAD + n * ROW_HEIGHT + if self.data.ports.len() > 1 { STOP_ALL + 5.0 } else { 0.0 }
    }

    /// Stops the commands behind `pids`: each shows a spinner until the call returns. The fixture's call returns at
    /// once (`finish_stop`); the host's will take its time.
    pub fn stop_ports(&mut self, pids: &[u32], cx: &mut Context<Self>) {
        for pid in pids {
            self.stopping.insert(*pid);
        }
        cx.notify();
        let pids = pids.to_vec();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(600)).await;
            this.update(cx, |this, cx| this.finish_stop(&pids, cx)).ok();
        })
        .detach();
    }

    /// The stop call returned: the ports leave the list; the last one closes the panel.
    pub fn finish_stop(&mut self, pids: &[u32], cx: &mut Context<Self>) {
        self.data.ports.retain(|port| !pids.contains(&port.pid));
        for pid in pids {
            self.stopping.remove(pid);
        }
        if self.data.ports.is_empty() && self.open == Some(super::Kind::Ports) {
            self.open = None;
            self.morph = None;
        }
        cx.notify();
    }

    pub fn is_stopping(&self, pid: u32) -> bool {
        self.stopping.contains(&pid)
    }

    pub(super) fn ports_panel(&mut self, _size: (f32, f32), cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let ports = self.data.ports.clone();
        let mut children: Vec<AnyElement> = Vec::new();
        if ports.len() > 1 {
            let pids: Vec<u32> = {
                let mut pids: Vec<u32> = ports.iter().map(|port| port.pid).collect();
                pids.dedup();
                pids
            };
            let all_stopping = ports.iter().all(|port| self.stopping.contains(&port.pid));
            children.push(
                div()
                    .flex_none()
                    .mb_1()
                    .pb_1()
                    .border_b_1()
                    .border_color(theme.line)
                    .child(
                        div()
                            .id("port-stop-all")
                            .debug_selector(|| "port-stop-all".into())
                            .flex()
                            .items_center()
                            .gap_2()
                            .w_full()
                            .h(px(STOP_ALL - 9.0))
                            .px_2()
                            .rounded(RADIUS_CHIP)
                            .text_step(TEXT_13)
                            .text_color(theme.ink2)
                            .when(all_stopping, |el| el.opacity(0.4))
                            .when(!all_stopping, |el| {
                                el.cursor_pointer()
                                    .hover(move |style| style.bg(theme.hover))
                                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.stop_ports(&pids, cx)))
                            })
                            .child(Icon::new(IconName::StopCircle).size(IconSize::S14).color(theme.ink2))
                            .child("Stop all"),
                    )
                    .into_any_element(),
            );
        }
        children.extend(ports.iter().map(|port| port_row(port, self.stopping.contains(&port.pid), &theme, cx)));
        div()
            .id("panel-ports")
            .debug_selector(|| "panel-ports".into())
            .size_full()
            .flex()
            .flex_col()
            .p(px(PANEL_PAD))
            .child(scroll_body("ports-body", &self.scroll, children))
            .into_any_element()
    }
}

fn port_row(port: &PortRow, stopping: bool, theme: &Theme, cx: &mut Context<PillRow>) -> AnyElement {
    let (pid, number) = (port.pid, port.port);
    let theme = *theme;
    div()
        .id(ElementId::from(SharedString::from(format!("port-{number}"))))
        .debug_selector(move || format!("port-row-{number}"))
        .group("port-row")
        .flex_none()
        .flex()
        .items_center()
        .gap_1()
        .h(px(ROW_HEIGHT))
        .pr_1()
        .rounded(RADIUS_CONTROL)
        .hover(move |style| style.bg(theme.hover2))
        .child(
            div()
                .id(ElementId::from(SharedString::from(format!("port-open-{number}"))))
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap_2()
                .h_full()
                .pl_2()
                .text_step(TEXT_13)
                .text_color(theme.ink)
                .cursor_pointer()
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.opened_port = Some(number);
                    this.set_open(None, true, window, cx);
                }))
                .child(div().flex_none().w(px(56.0)).font_family(mono()).child(format!(":{number}")))
                .child(div().flex_1().min_w_0().truncate().text_color(theme.ink3).child(match &port.computer {
                    Some(computer) => format!("{} \u{b7} on {computer}", port.command),
                    None => port.command.clone(),
                }))
                .child(
                    div()
                        .flex_none()
                        .opacity(0.0)
                        .group_hover("port-row", |style| style.opacity(1.0))
                        .child(Icon::new(IconName::LinkSquare02).size(IconSize::S14).color(theme.ink3)),
                ),
        )
        .child(if stopping {
            div()
                .debug_selector(move || format!("port-stopping-{number}"))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(24.0))
                .child(SpinnerRing::new().size(12.0))
                .into_any_element()
        } else {
            div()
                .flex_none()
                .opacity(0.0)
                .group_hover("port-row", |style| style.opacity(1.0))
                .child(
                    IconButton::new(ElementId::from(SharedString::from(format!("port-stop-{number}"))), IconName::StopCircle)
                        .size(IconButtonSize::S24)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.stop_ports(&[pid], cx))),
                )
                .into_any_element()
        })
        .into_any_element()
}

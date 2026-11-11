//! The notices at the window's top (C-08; `App.tsx` `PersistenceNotices`, `PersistenceNotice.tsx`): the host is out of
//! date (Restart host), the host is gone (Reconnecting, or the restart failed), and a Project's changes that did not
//! reach the disk (Retry saving). They stay while the cause stays; save failures cannot be dismissed.
//!
//! Not built: the 40%-of-the-window scroll of a long list of save failures (they stack).

use std::time::Duration;

use gpui::{Context, FontWeight, IntoElement, Render, Task, Window, div, prelude::*, px};

use super::model::{HOST_OUTDATED_DEFAULT, HostConnection, UnsavedScope};
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_12, TEXT_13, TextStepExt};
use crate::ui::{Button, ButtonSize, ButtonVariant, Notice};

/// `max-w-2xl`.
pub const MAX_WIDTH: f32 = 672.0;
const STEP: Duration = Duration::from_millis(600);

pub struct HostNotices {
    connection: HostConnection,
    restarting: bool,
    saves: Vec<UnsavedScope>,
    /// Scopes whose Retry saving is under way.
    retrying: Vec<String>,
    _task: Option<Task<()>>,
}

impl HostNotices {
    pub fn new() -> Self {
        Self { connection: HostConnection::online(), restarting: false, saves: Vec::new(), retrying: Vec::new(), _task: None }
    }

    pub fn set_connection(&mut self, connection: HostConnection, cx: &mut Context<Self>) {
        self.connection = connection;
        cx.notify();
    }

    pub fn set_saves(&mut self, saves: Vec<UnsavedScope>, cx: &mut Context<Self>) {
        self.saves = saves;
        cx.notify();
    }

    pub fn connection(&self) -> &HostConnection {
        &self.connection
    }

    pub fn saves(&self) -> &[UnsavedScope] {
        &self.saves
    }

    pub fn is_restarting(&self) -> bool {
        self.restarting
    }

    pub fn is_empty(&self) -> bool {
        self.saves.is_empty() && self.connection.connected && !self.connection.host_outdated
    }

    /// `runtime:restart-host`: the fixture brings the host back up to date.
    pub fn restart_host(&mut self, cx: &mut Context<Self>) {
        if self.restarting {
            return;
        }
        self.restarting = true;
        cx.notify();
        self._task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(STEP).await;
            this.update(cx, |this, cx| {
                this.restarting = false;
                this.connection = HostConnection::online();
                cx.notify();
            })
            .ok();
        }));
    }

    /// `scope:retry-save`: a scope whose computer is connected saves again and leaves the list.
    pub fn retry_save(&mut self, scope: &str, cx: &mut Context<Self>) {
        let Some(item) = self.saves.iter().find(|item| item.scope == scope) else { return };
        if item.offline || item.saving || self.retrying.iter().any(|s| s == scope) {
            return;
        }
        self.retrying.push(scope.to_string());
        cx.notify();
        let scope = scope.to_string();
        self._task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(STEP).await;
            this.update(cx, |this, cx| {
                this.retrying.retain(|s| *s != scope);
                this.saves.retain(|item| item.scope != scope);
                cx.notify();
            })
            .ok();
        }));
    }

    fn save_failure(&self, item: &UnsavedScope, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = *cx.theme();
        let saving = item.saving || self.retrying.contains(&item.scope);
        let scope = item.scope.clone();
        let this = cx.entity();
        // The error card sits on a surface with the raised shadow because it floats over the app.
        div()
            .debug_selector(|| "save-failure".into())
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .p(px(12.0))
                    .rounded(RADIUS_CARD)
                    .bg(theme.red_tint)
                    .text_color(theme.red_ink)
                    .text_step(TEXT_13)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!("Changes to {} haven\u{2019}t been saved on your computer.", item.name)),
                            )
                            .child(div().mt(px(4.0)).child(if item.offline {
                                "Computer disconnected. Reconnect to check saving."
                            } else {
                                "Changes are kept in memory. Keep your computer running until saving succeeds."
                            }))
                            .when(!item.offline, |col| col.child(div().mt(px(4.0)).text_step(TEXT_12).child(item.detail()))),
                    )
                    .child(
                        div().flex_none().child(
                            Button::new(
                                format!("retry-save-{scope}"),
                                if saving && !item.offline { "Saving\u{2026}" } else { "Retry saving" },
                            )
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .disabled(item.offline || saving)
                            .on_click(move |_, _, cx| this.update(cx, |this, cx| this.retry_save(&scope, cx))),
                        ),
                    ),
            )
            .into_any_element()
    }
}

impl Default for HostNotices {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for HostNotices {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.is_empty() {
            return div().into_any_element();
        }
        let theme = *cx.theme();
        let this = cx.entity();
        let connection = self.connection.clone();
        let mut stack = div().id("host-notices").flex().flex_col().gap(px(8.0)).w_full().max_w(px(MAX_WIDTH));
        if connection.connected && connection.host_outdated {
            stack = stack.child(
                div().debug_selector(|| "host-outdated".into()).child(
                    Notice::new()
                        .action(
                            Button::new("restart-host", if self.restarting { "Restarting\u{2026}" } else { "Restart host" })
                                .size(ButtonSize::S28)
                                .disabled(self.restarting)
                                .on_click(move |_, _, cx| this.update(cx, |this, cx| this.restart_host(cx))),
                        )
                        .child(connection.message.clone().unwrap_or_else(|| HOST_OUTDATED_DEFAULT.to_string())),
                ),
            );
        }
        if !connection.connected {
            let (title, body) = if connection.failed {
                (
                    "Couldn\u{2019}t restart Milagre\u{2019}s background host",
                    format!(
                        "{} Your draft is kept here. Quit and reopen Milagre to try again.",
                        connection.message.clone().unwrap_or_default()
                    ),
                )
            } else {
                (
                    "Reconnecting to your computer",
                    "Your draft is kept here. Messages will be available when the host reconnects.".to_string(),
                )
            };
            stack = stack.child(
                div().debug_selector(|| "host-disconnected".into()).child(
                    Notice::new()
                        .child(div().font_weight(FontWeight::MEDIUM).child(title))
                        .child(div().mt(px(4.0)).text_color(theme.ink2).child(body.trim().to_string())),
                ),
            );
        }
        for item in self.saves.clone() {
            stack = stack.child(self.save_failure(&item, cx));
        }
        stack.into_any_element()
    }
}

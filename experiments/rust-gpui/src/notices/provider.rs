//! The provider CLI update card (C-08; `ProviderUpdateNotice.tsx`, `use-provider-updates.ts`): a card at the window's
//! bottom right naming a provider whose CLI has a newer release on this computer, with Settings and Update. The queue
//! shows one at a time, oldest first; a dismissed release stays hidden, a newer one shows again.

use std::collections::HashSet;
use std::time::Duration;

use gpui::{Context, EventEmitter, FontWeight, IntoElement, Render, Task, Window, div, prelude::*, px};

use super::NoticeEvent;
use super::model::ProviderUpdate;
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_11, TEXT_13, TEXT_15, TextStepExt};
use crate::ui::{Button, ButtonVariant, ErrorVariant, IconButton, IconName, InlineError, ProviderLogo};

pub const CARD_WIDTH: f32 = 360.0;
const STEP: Duration = Duration::from_millis(500);

pub struct ProviderUpdateNotice {
    queue: Vec<ProviderUpdate>,
    dismissed: HashSet<String>,
    working: bool,
    error: String,
    /// The fixture's install fails once, so Retry is seen.
    fail_next: bool,
    _task: Option<Task<()>>,
}

impl EventEmitter<NoticeEvent> for ProviderUpdateNotice {}

impl ProviderUpdateNotice {
    pub fn new() -> Self {
        Self { queue: Vec::new(), dismissed: HashSet::new(), working: false, error: String::new(), fail_next: false, _task: None }
    }

    /// `agent:provider-updates`.
    pub fn set_updates(&mut self, updates: Vec<ProviderUpdate>, cx: &mut Context<Self>) {
        self.queue = updates;
        cx.notify();
    }

    /// The fixture's install fails the first time.
    pub fn fail_first_install(&mut self) {
        self.fail_next = true;
    }

    /// The release on show: the first not dismissed.
    pub fn current(&self) -> Option<&ProviderUpdate> {
        self.queue.iter().find(|update| !self.dismissed.contains(&update.key()))
    }

    pub fn is_working(&self) -> bool {
        self.working
    }

    pub fn error(&self) -> &str {
        &self.error
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        if self.working {
            return;
        }
        if let Some(key) = self.current().map(ProviderUpdate::key) {
            self.dismissed.insert(key);
            self.error.clear();
            cx.notify();
        }
    }

    /// `agent:update-cli`: the card goes when it works.
    pub fn install(&mut self, cx: &mut Context<Self>) {
        let Some(update) = self.current().cloned() else { return };
        if self.working {
            return;
        }
        self.working = true;
        self.error.clear();
        cx.notify();
        let fail = std::mem::take(&mut self.fail_next);
        self._task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(STEP).await;
            this.update(cx, |this, cx| {
                this.working = false;
                if fail {
                    this.error = "The update could not be installed. Check your connection and try again.".into();
                } else {
                    this.queue.retain(|item| *item != update);
                }
                cx.notify();
            })
            .ok();
        }));
    }
}

impl Default for ProviderUpdateNotice {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for ProviderUpdateNotice {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(current) = self.current().cloned() else { return div().into_any_element() };
        let theme = *cx.theme();
        let name = current.provider.name();
        let (dismiss, install, settings) = (cx.entity(), cx.entity(), cx.entity());
        div()
            .id("provider-update")
            .debug_selector(|| "provider-update".into())
            .relative()
            .w(px(CARD_WIDTH))
            .max_w_full()
            .p(px(16.0))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .text_color(theme.ink)
            .shadow(theme.shadow_raised())
            .child(
                div().absolute().top(px(8.0)).right(px(8.0)).flex().child(
                    IconButton::new("provider-update-dismiss", IconName::Cancel01)
                        .disabled(self.working)
                        .on_click(move |_, _, cx| dismiss.update(cx, |this, cx| this.dismiss(cx))),
                ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .pr(px(24.0))
                    .text_step(TEXT_15)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(
                        div().relative().flex_none().child(ProviderLogo::new(current.provider).size(18.0)).child(
                            div()
                                .absolute()
                                .bottom(px(-4.0))
                                .right(px(-4.0))
                                .rounded_full()
                                .bg(theme.surface)
                                .text_step(TEXT_11)
                                .line_height(px(11.0))
                                .text_color(theme.green_ink)
                                .child("\u{2193}"),
                        ),
                    )
                    .child(format!("Update available: {name} v{}", current.version)),
            )
            .child(div().mt(px(8.0)).text_step(TEXT_13).text_color(theme.ink3).child("Install the update now or review provider settings."))
            .when(!self.error.is_empty(), |card| {
                card.child(div().mt(px(8.0)).child(InlineError::new(self.error.clone()).small().variant(ErrorVariant::Inline)))
            })
            .child(
                div()
                    .mt(px(12.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        Button::new("provider-update-settings", "Settings")
                            .variant(ButtonVariant::Secondary)
                            .on_click(move |_, _, cx| settings.update(cx, |_, cx| cx.emit(NoticeEvent::OpenSettings))),
                    )
                    .child(
                        Button::new(
                            "provider-update-install",
                            if self.working {
                                "Updating\u{2026}"
                            } else if self.error.is_empty() {
                                "Update"
                            } else {
                                "Retry"
                            },
                        )
                        .disabled(self.working)
                        .on_click(move |_, _, cx| install.update(cx, |this, cx| this.install(cx))),
                    ),
            )
            .into_any_element()
    }
}

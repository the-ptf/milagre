//! Notices (WP-52): the update pill and its card, the provider CLI update card, the host and save notices at the
//! window's top, and the "Opened in \u{2026}" toast. After `apps/desktop/app/src/components/UpdateNotice.tsx`,
//! `ProviderUpdateNotice.tsx`, `PersistenceNotice.tsx`, `editor-links.tsx` and `App.tsx`'s notice stack.
//!
//! | File | Holds |
//! | --- | --- |
//! | `model.rs` | `AppUpdate` and its words, `Presentation` (when the card opens and hides), `ProviderUpdate`, `HostConnection`, `UnsavedScope` |
//! | `update.rs` | `UpdateNotice`: the pill that opens into the card, What's new, Install & restart |
//! | `provider.rs` | `ProviderUpdateNotice`: the CLI update card |
//! | `host.rs` | `HostNotices`: Restart host, Reconnecting, Retry saving |
//! | `fixture.rs` | `Scenario`: the state each snapshot and test starts from (`MILAGRE_GPUI_NOTICES=<name>`) |
//!
//! [`NoticesLayer`] mounts them over the window (the [`crate::workspace::Workspace`] draws it above the columns, under
//! Settings and the palette). It draws no box of its own, so it takes no click that is not on a notice. Fixture data
//! only: nothing checks for updates.
//!
//! Not built: Ultracode Fatality (K-16, optional; its sparks and audio clip), and the composer's pill slot (the pill
//! hangs from the Chat column's bottom left, the desktop's fallback without a Chat; see `update.rs`).

pub mod driver;
pub mod fixture;
pub mod host;
pub mod model;
pub mod provider;
pub mod update;

#[cfg(test)]
mod tests;

use std::time::Duration;

use gpui::{Context, Entity, EventEmitter, IntoElement, Render, SharedString, Subscription, Task, Window, div, prelude::*, px};

use crate::overlays::dialogs::Host;
use crate::ui::Toast;
pub use fixture::Scenario;
pub use host::HostNotices;
pub use provider::ProviderUpdateNotice;
pub use update::UpdateNotice;

/// What the layer asks the window for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoticeEvent {
    /// The provider card's Settings.
    OpenSettings,
}

/// How long a toast stays (`lib/toast.ts`).
pub const TOAST_FOR: Duration = Duration::from_millis(2600);
/// The window's edge inset for the pill and the provider card (`bottom-4 left-4`, `bottom-5 right-5`).
const PILL_INSET: f32 = 16.0;
/// The pill hangs from the Chat column's bottom left, clear of the sidebar (a collapsed rail leaves a gap).
const PILL_LEFT: f32 = crate::workspace::sidebar::SIDEBAR_WIDTH + 1.0 + PILL_INSET;
const CARD_INSET: f32 = 20.0;
/// `top-12`: under the 44px header.
const HOST_TOP: f32 = 48.0;

pub struct NoticesLayer {
    pub update: Entity<UpdateNotice>,
    pub provider: Entity<ProviderUpdateNotice>,
    pub host: Entity<HostNotices>,
    toast: Option<SharedString>,
    _toast_task: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<NoticeEvent> for NoticesLayer {}

impl NoticesLayer {
    /// A layer with nothing to show; `MILAGRE_GPUI_NOTICES` picks a [`Scenario`] for a snapshot run.
    pub fn new(host: Host, cx: &mut Context<Self>) -> Self {
        let update = cx.new(|cx| UpdateNotice::new(host, cx));
        let provider = cx.new(|_| ProviderUpdateNotice::new());
        let host_notices = cx.new(|_| HostNotices::new());
        let forward = cx.subscribe(&provider, |_, _, event: &NoticeEvent, cx| cx.emit(event.clone()));
        let mut layer = Self { update, provider, host: host_notices, toast: None, _toast_task: None, _subscriptions: vec![forward] };
        if let Some(scenario) = std::env::var("MILAGRE_GPUI_NOTICES").ok().and_then(|name| Scenario::from_name(&name)) {
            layer.apply(scenario, cx);
        }
        layer
    }

    pub fn apply(&mut self, scenario: Scenario, cx: &mut Context<Self>) {
        scenario.apply(self, cx);
    }

    /// A one-line toast at the bottom for [`TOAST_FOR`] ("Opened in Zed").
    pub fn show_toast(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.toast = Some(text.into());
        cx.notify();
        self._toast_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST_FOR).await;
            this.update(cx, |this, cx| {
                this.toast = None;
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn toast(&self) -> Option<&str> {
        self.toast.as_deref()
    }
}

impl Render for NoticesLayer {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .inset_0()
            .child(div().absolute().top(px(HOST_TOP)).left(px(16.0)).right(px(16.0)).flex().justify_center().child(self.host.clone()))
            .child(div().absolute().bottom(px(CARD_INSET)).right(px(CARD_INSET)).max_w_full().child(self.provider.clone()))
            .child(div().absolute().bottom(px(PILL_INSET)).left(px(PILL_LEFT)).child(self.update.clone()))
            .when_some(self.toast.clone(), |layer, text| {
                layer.child(
                    div()
                        .absolute()
                        .bottom(px(16.0))
                        .left_0()
                        .right_0()
                        .px(px(24.0))
                        .flex()
                        .justify_center()
                        .child(div().w(px(420.0)).max_w_full().child(Toast::new(text))),
                )
            })
    }
}

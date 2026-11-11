//! The composer's bottom row (`PromptComposer.tsx` footer, DESIGN.md "Composer" and the decided two-row layout):
//! the prompt on top; below it the attach button on the left, and on the right the model chip, the context slot and
//! the send button, which is Stop while a turn runs and nothing can be sent. There is no microphone (dictation is out
//! of scope) and no permission chip: the permission mode lives in the model picker (`permission.rs`).
//!
//! - Attach opens the platform's file prompt (`Composer::open_file_picker`); the chosen paths go to the tray.
//! - The model chip is a trigger chip (`ui::Chip`, transparent `ink-2`, `hover-2` while open); its picker is
//!   `model_picker.rs`.
//! - The context slot is the ring and its card (`context.rs`), shown once the data layer gives the tokens
//!   ([`Composer::set_context`], [`Composer::set_context_percent`]).
//! - The send button is `send::SendState`'s decision: Send, Send now (steers), Queue message, or Stop (a 10px
//!   square with 2px corners); disabled at 40% when there is nothing to send.

use gpui::{ClickEvent, Context, SharedString, div, prelude::*, px};

use super::Composer;
use super::send::{Delivery, MessageSink, SendAction, SendState};
use crate::data::{PermissionMode, Provider};
use crate::logic::identity::capabilities::provider_capabilities;
use crate::theme::{CONTROL_SM, Theme};
use crate::ui::{Icon, IconButton, IconName, Tooltip};

use std::rc::Rc;

/// What the bottom row shows and decides from; the data layer sets it.
#[derive(Clone)]
pub struct BarState {
    pub running: bool,
    pub can_steer: bool,
    pub follow_ups: Delivery,
    pub compacting: bool,
    pub blocked: bool,
    pub permission: PermissionMode,
    pub provider: Provider,
    pub model_id: SharedString,
    pub model_name: SharedString,
    pub effort: Option<SharedString>,
    /// The effort's id ("medium"); `effort` is its name.
    pub effort_id: Option<&'static str>,
    pub fast: bool,
    pub ultracode: bool,
    /// The provider tab the model picker shows.
    pub tab: Provider,
    /// Used and total tokens of the context window.
    pub context: Option<(f64, f64)>,
    /// The composer popover that is open (`pick_list::popup`).
    pub open: Option<&'static str>,
    /// The permission menu inside the model picker is open.
    pub permission_menu: bool,
}

impl Default for BarState {
    fn default() -> Self {
        Self {
            running: false,
            can_steer: provider_capabilities(Some(Provider::Claude.id())).steer,
            follow_ups: Delivery::Now,
            compacting: false,
            blocked: false,
            permission: PermissionMode::Ask,
            provider: Provider::Claude,
            model_id: "claude-opus-5-5".into(),
            model_name: "Opus 5.5".into(),
            effort: Some("Medium".into()),
            effort_id: Some("medium"),
            fast: false,
            ultracode: false,
            tab: Provider::Claude,
            context: None,
            open: None,
            permission_menu: false,
        }
    }
}

/// `PERMISSION_MODE_LABEL`.
pub fn permission_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "Ask",
        PermissionMode::Auto => "Auto",
        PermissionMode::Full => "Full",
    }
}

const STOP_SQUARE: f32 = 10.0;

impl Composer {
    /// A turn runs in this Chat: a send steers or queues, and the send button becomes Stop when nothing is typed.
    pub fn set_running(&mut self, running: bool, cx: &mut Context<Self>) {
        self.bar.running = running;
        cx.notify();
    }

    /// Settings › Chat › Messages during a turn.
    pub fn set_follow_ups(&mut self, follow_ups: Delivery, cx: &mut Context<Self>) {
        self.bar.follow_ups = follow_ups;
        cx.notify();
    }

    pub fn set_compacting(&mut self, compacting: bool, cx: &mut Context<Self>) {
        self.bar.compacting = compacting;
        cx.notify();
    }

    /// The composer cannot send now (`sendBlocked`).
    pub fn set_blocked(&mut self, blocked: bool, cx: &mut Context<Self>) {
        self.bar.blocked = blocked;
        cx.notify();
    }

    pub fn set_permission_mode(&mut self, mode: PermissionMode, cx: &mut Context<Self>) {
        self.bar.permission = mode;
        cx.notify();
    }

    /// The model chip's content; whether the provider steers follows from it.
    pub fn set_model(&mut self, provider: Provider, id: &str, name: &str, effort: Option<&str>, cx: &mut Context<Self>) {
        self.bar.provider = provider;
        self.bar.can_steer = provider_capabilities(Some(provider.id())).steer;
        self.bar.model_id = id.to_string().into();
        self.bar.model_name = name.to_string().into();
        self.bar.tab = provider;
        self.bar.effort = effort.map(|effort| effort.to_string().into());
        self.bar.effort_id = None;
        cx.notify();
    }

    pub fn set_context_percent(&mut self, percent: Option<u8>, cx: &mut Context<Self>) {
        self.bar.context = percent.map(|percent| (f64::from(percent) * 2000.0, 200_000.0));
        cx.notify();
    }

    /// Where sends, Stop and the queue's buttons go (the data layer implements it).
    pub fn set_sink(&mut self, sink: Option<Rc<dyn MessageSink>>) {
        self.sink = sink;
    }

    pub fn is_running(&self) -> bool {
        self.bar.running
    }

    /// There is something to send: text, a quote, an image or a file (`canSend`).
    pub fn can_send(&self) -> bool {
        !self.shown.trim().is_empty() || !self.quotes.is_empty() || !self.tray.is_empty()
    }

    pub fn send_state(&self) -> SendState {
        SendState {
            can_send: self.can_send(),
            running: self.bar.running,
            can_steer: self.bar.can_steer,
            follow_ups: self.bar.follow_ups,
            compacting: self.bar.compacting,
            blocked: self.bar.blocked,
        }
    }

    /// The send button's label right now (its accessible name).
    pub fn send_label(&self) -> &'static str {
        self.send_state().label()
    }

    /// A snapshot's bar state (`MILAGRE_GPUI_COMPOSER_BAR`): `1` is a running Chat that queues, with two images and a
    /// file in the tray, text typed and two messages queued; `stop` is the same Chat with nothing typed, one queued
    /// message and the Stop button.
    pub(super) fn seed_demo(&mut self, mode: &str, window: &mut gpui::Window, cx: &mut Context<Self>) {
        let images = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/assets/images");
        self.bar.running = true;
        self.bar.follow_ups = Delivery::Queue;
        self.bar.context = Some((84_000.0, 200_000.0));
        let (model, provider) = (self.bar.model_id.clone(), self.bar.provider);
        let queued = move |id: &str, body: &str, files: usize| crate::data::QueuedMessage {
            id: id.to_string().into(),
            body: body.to_string().into(),
            files: (0..files).map(|n| format!("/tmp/file-{n}.txt").into()).collect(),
            model: model.clone(),
            provider,
            queued_at: 0,
            client_message_id: None,
        };
        if mode == "stop" {
            self.set_queue(vec![queued("q1", "Also run the Linux smoke check", 0)], false, cx);
            return;
        }
        let notes = std::env::temp_dir().join("release-notes.md");
        let _ = std::fs::write(&notes, "# Release notes\n");
        self.attach_paths(vec![images.join("viewed-checker.png"), images.join("viewed-wide.png"), notes], 0..0, window, cx);
        let text = self.text().to_string();
        let end = text.len();
        self.put(format!("{text}Compare these two screenshots"), end + 29..end + 29, None, window, cx);
        self.set_queue(vec![queued("q1", "Also run the Linux smoke check", 0), queued("q2", "", 2)], false, cx);
    }

    pub(super) fn render_send_row(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let state = self.send_state();
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap_1()
            .h(CONTROL_SM)
            .px(px(super::FRAME_PAD - super::FRAME_PAD_X))
            .child(
                div().id("composer-attach-tip").tooltip(Tooltip::text("Attach files")).child(
                    IconButton::new("composer-attach", IconName::Attachment01)
                        .pill()
                        .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.open_file_picker(window, cx))),
                ),
            )
            .child(div().flex_1())
            .child(self.model_chip(theme, cx))
            .child(self.context_slot(theme, cx))
            .child(self.send_button(state, theme, cx))
    }

    fn send_button(&self, state: SendState, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let action = state.button();
        let enabled = action != SendAction::Nothing;
        let on_ink = theme.on_ink;
        div()
            .id("composer-send")
            .debug_selector(|| "composer-send".into())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(CONTROL_SM)
            .rounded_full()
            .bg(theme.ink)
            .tooltip(Tooltip::text(state.label()))
            .when(!enabled, |el| el.opacity(0.4).cursor_not_allowed())
            .when(enabled, |el| {
                el.cursor_pointer()
                    .hover(|style| style.opacity(0.9))
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.press_send(window, cx)))
            })
            .child(if action == SendAction::Stop {
                // A stop square, not a dot that reads as record.
                div().debug_selector(|| "composer-stop-square".into()).size(px(STOP_SQUARE)).rounded(px(2.0)).bg(on_ink).into_any_element()
            } else {
                Icon::new(IconName::ArrowUp02).color(on_ink).into_any_element()
            })
    }
}

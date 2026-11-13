//! Queued messages (`QueuedMessages.tsx`, `queued-messages.mjs`), docked above the composer: messages sent while a
//! turn runs that wait for it to end, oldest first. The look is the card WP-23 drew in the transcript (a `surface`
//! card, `rounded-card`, `shadow-raised`, 6px inset, a "Queued · when they go" line, rows that take `hover`), now
//! where the app keeps it. Each row has Send now (Stop and send when the turn cannot be steered), Edit and Remove.
//!
//! - The host keeps the queue (`AgentSession.queued`): [`Composer::set_queue`] takes the real one. Until the data
//!   layer feeds it, a message queued here is the composer's own entry, and the [`MessageSink`] is told.
//! - Send now takes the message off the queue and sends it into the running turn (`ComposerEvent::Send`, so the
//!   transcript echoes it); when the turn cannot steer it stops the turn first (`MessageSink::stop`).
//! - Edit is React-less (the app has Send now and Remove only): it takes the message off the queue and puts its
//!   text, attachments and quotes back in the composer. Only an empty composer takes it back; otherwise the button
//!   is disabled, so nothing is overwritten and no image numbering has to merge.
//! - Steering is not a separate list: a send that steers goes straight into the running turn (transcript echo) and
//!   is never queued; which one a send does is `send::SendState`.

use gpui::{AnyElement, ClickEvent, Context, ElementId, FontWeight, SharedString, Window, div, prelude::*, px};

use super::attachments::Attachment;
use super::send::OutgoingMessage;
use super::{Composer, ComposerEvent};
use crate::data::QueuedMessage;
use crate::logic::activity::queued::queue_status;
use crate::logic::prompts::parts::ComposerQuote;
use crate::theme::{CONTROL_XS, RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, IconButton, IconButtonSize, IconName};

/// One waiting message: what the host's list shows, and what Edit needs to put it back.
#[derive(Clone)]
pub struct QueuedEntry {
    pub message: QueuedMessage,
    pub outgoing: Option<OutgoingMessage>,
    pub attachments: Vec<Attachment>,
    pub quotes: Vec<ComposerQuote>,
}

#[derive(Default)]
pub struct Queue {
    items: Vec<QueuedEntry>,
    /// Stop (or a failure) ended the turn they waited on: they wait for Send now.
    held: bool,
    next_id: u64,
}

impl Queue {
    pub fn items(&self) -> &[QueuedEntry] {
        &self.items
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn held(&self) -> bool {
        self.held
    }
}

/// " · 1 image, 2 files" after a queued message's text (`attachmentNote`).
fn attachment_note(entry: &QueuedEntry) -> Option<String> {
    let (images, files) = match &entry.outgoing {
        Some(outgoing) => (outgoing.images.len(), outgoing.files.len()),
        None => (0, entry.message.files.len()),
    };
    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    let parts: Vec<String> =
        [(images, "image"), (files, "file")].into_iter().filter(|(n, _)| *n > 0).map(|(n, word)| plural(n, word)).collect();
    (!parts.is_empty()).then(|| parts.join(", "))
}

impl Composer {
    pub fn queued(&self) -> &[QueuedEntry] {
        self.queue.items()
    }

    pub fn queue_held(&self) -> bool {
        self.queue.held()
    }

    /// The host's queue for this Chat (`session.queued`, `session.queueHeld`).
    pub fn set_queue(&mut self, items: Vec<QueuedMessage>, held: bool, cx: &mut Context<Self>) {
        self.queue.items =
            items.into_iter().map(|message| QueuedEntry { message, outgoing: None, attachments: Vec::new(), quotes: Vec::new() }).collect();
        self.queue.held = held;
        cx.notify();
    }

    /// A send that waits: the message joins the queue and the sink hears about it as an ordinary send.
    pub(super) fn enqueue(&mut self, outgoing: OutgoingMessage, quotes: Vec<ComposerQuote>, cx: &mut Context<Self>) {
        self.queue.next_id += 1;
        let message = QueuedMessage {
            id: format!("queued-{}", self.queue.next_id).into(),
            body: outgoing.prompt.clone().into(),
            files: outgoing.files.iter().filter_map(|file| file.path.as_ref()).map(|path| path.display().to_string().into()).collect(),
            model: self.bar.model_id.clone(),
            provider: self.bar.provider,
            queued_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64),
            client_message_id: None,
        };
        let attachments = self.tray.items().to_vec();
        if let Some(sink) = &self.sink {
            sink.send(outgoing.clone());
        }
        self.queue.items.push(QueuedEntry { message, outgoing: Some(outgoing), attachments, quotes });
        cx.notify();
    }

    /// Send now: off the queue and into the running turn; a turn that cannot be steered is stopped first.
    pub fn send_queued_now(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(at) = self.queue.items.iter().position(|entry| entry.message.id == id) else { return };
        let entry = self.queue.items.remove(at);
        if self.bar.running && !self.bar.can_steer {
            if let Some(sink) = &self.sink {
                sink.stop();
            }
            cx.emit(ComposerEvent::Stop);
        }
        if let Some(sink) = &self.sink {
            sink.send_queued_now(id);
        }
        self.queue.held = false;
        cx.emit(ComposerEvent::Send(entry.message.body.clone()));
        cx.notify();
    }

    pub fn remove_queued(&mut self, id: &str, cx: &mut Context<Self>) {
        let before = self.queue.items.len();
        self.queue.items.retain(|entry| entry.message.id != id);
        if self.queue.items.len() != before {
            if let Some(sink) = &self.sink {
                sink.remove_queued(id);
            }
            cx.notify();
        }
    }

    /// Whether Edit can put a queued message back: the draft, the tray and the quotes are all empty.
    pub fn can_edit_queued(&self) -> bool {
        self.shown.trim().is_empty() && self.tray.is_empty() && self.quotes.is_empty()
    }

    /// Edit: the message leaves the queue and its text, attachments and quotes are the draft again.
    pub fn edit_queued(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_edit_queued() {
            return;
        }
        let Some(at) = self.queue.items.iter().position(|entry| entry.message.id == id) else { return };
        let entry = self.queue.items.remove(at);
        if let Some(sink) = &self.sink {
            sink.remove_queued(id);
        }
        self.tray.restore(entry.attachments);
        self.image_count = self.tray.image_count();
        self.quotes = entry.quotes;
        // The typed text, not the quotes that were folded into the message.
        let text = entry.outgoing.as_ref().map_or_else(|| entry.message.body.to_string(), |outgoing| outgoing.text.clone());
        self.set_text(&text, window, cx);
        cx.notify();
    }

    pub(super) fn render_queue(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.queue.is_empty() {
            return None;
        }
        let stop_and_send = self.bar.running && !self.bar.can_steer;
        let editable = self.can_edit_queued();
        let mut list = div().flex().flex_col();
        for (n, entry) in self.queue.items().iter().enumerate() {
            let id = entry.message.id.clone();
            let body = if entry.message.body.trim().is_empty() { SharedString::from("Attachments") } else { entry.message.body.clone() };
            let (send_id, edit_id, remove_id) = (id.clone(), id.clone(), id);
            list = list.child(
                div()
                    .debug_selector(move || format!("queued-message-{n}"))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded(RADIUS_CONTROL)
                    .hover(|style| style.bg(theme.hover))
                    .child(div().min_w_0().flex_1().flex().child(div().min_w_0().truncate().child(body)).children(
                        attachment_note(entry).map(|note| div().flex_none().text_color(theme.ink3).child(format!(" \u{b7} {note}"))),
                    ))
                    .child(
                        Button::new(
                            ElementId::from(SharedString::from(format!("queued-send-{n}"))),
                            if stop_and_send { "Stop and send" } else { "Send now" },
                        )
                        .variant(ButtonVariant::Quiet)
                        .size(ButtonSize::S24)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.send_queued_now(&send_id, cx))),
                    )
                    .child(
                        Button::new(ElementId::from(SharedString::from(format!("queued-edit-{n}"))), "Edit")
                            .variant(ButtonVariant::Quiet)
                            .size(ButtonSize::S24)
                            .disabled(!editable)
                            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| this.edit_queued(&edit_id, window, cx))),
                    )
                    .child(
                        IconButton::new(ElementId::from(SharedString::from(format!("queued-remove-{n}"))), IconName::Cancel01)
                            .size(IconButtonSize::S24)
                            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.remove_queued(&remove_id, cx))),
                    ),
            );
        }
        let running = self.bar.running;
        Some(
            div()
                .debug_selector(|| "composer-queue".into())
                .w_full()
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .px(px(6.0))
                .py(px(6.0))
                .text_step(TEXT_13)
                .text_color(theme.ink)
                .child(
                    div().px_2().pt(px(2.0)).pb_1().h(CONTROL_XS).text_step(TEXT_12).text_color(theme.ink3).child(
                        div()
                            .flex()
                            .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Queued"))
                            .child(format!(" \u{b7} {}", queue_status(self.queue.len(), self.queue.held(), running))),
                    ),
                )
                .child(list)
                .into_any_element(),
        )
    }
}

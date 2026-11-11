//! Add computer (O-06; `AddComputerDialog.tsx`): paste another computer's pairing link, see the computer it names,
//! and pair with it, waiting while its owner clicks Allow there.
//!
//! - Each change to the link is read again before anything is sent; an answer that arrives late is dropped.
//! - "LAN or Tailscale only" keeps the link's private routes and drops the public fallback; a link with none says so.
//! - Pairing shows "Connecting…"; once the host reports the other computer is being asked, the footer says who it
//!   waits for. Cancel (and closing the dialog) stops the pairing.

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, Entity, FontWeight, IntoElement, Render, Subscription, Task, Window, div,
    prelude::*, px,
};
use gpui_component::input::{InputEvent, InputState};

use super::host::ComputerPreview;
use super::{Host, STEP, call, field_label, footer};
use crate::theme::{ActiveTheme, RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, mono};
use crate::ui::{Button, ButtonSize, ButtonVariant, Checkbox, Dialog, Icon, IconName, IconSize, InlineError, Input};

/// The computer's word for itself in this dialog's sentences.
const THIS_COMPUTER: &str = "this computer";

type Added = Rc<dyn Fn(&str, &mut App)>;

/// A link's private routes only (`privatePairingLink`): the link when it names at least one private route, else the
/// reason it cannot be used that way.
pub fn private_pairing_link(link: &str) -> Result<String, String> {
    let query = link.trim().strip_prefix("milagre://pair?").or_else(|| link.trim().strip_prefix("milagre://pair/?"));
    let query =
        query.ok_or_else(|| "That is not a Milagre pairing link. Scan the code your Mac shows, or copy its pairing link.".to_string())?;
    let direct = query
        .split('&')
        .find_map(|part| part.strip_prefix("direct="))
        .map(|value| value.replace("%22", "\"").replace("%5B", "[").replace("%5D", "]"));
    let has_route = direct.and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok()).is_some_and(|routes| !routes.is_empty());
    if has_route {
        Ok(link.trim().to_string())
    } else {
        Err("This code has no private network address. Choose LAN or Tailscale only in Settings \u{2192} Devices on your computer and copy its new link.".to_string())
    }
}

pub struct AddComputerDialog {
    host: Host,
    link: Entity<InputState>,
    name: Entity<InputState>,
    typed_name: bool,
    /// The name the dialog last wrote into the field.
    last_set: Option<String>,
    private_only: bool,
    preview: Option<ComputerPreview>,
    error: Option<String>,
    adding: bool,
    waiting: bool,
    /// The newest read of the link; an older answer is dropped.
    reads: usize,
    on_added: Added,
    _subscriptions: Vec<Subscription>,
    _read: Option<Task<()>>,
    _add: Option<Task<()>>,
    _pending: Option<Task<()>>,
}

impl AddComputerDialog {
    fn new(host: Host, on_added: Added, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let link = Input::state("milagre://pair?\u{2026}", window, cx);
        let name = Input::state("", window, cx);
        let subscriptions = vec![
            cx.subscribe_in(&link, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.read_link(window, cx);
                }
            }),
            cx.subscribe(&name, |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    // A value other than the one we put there is the person's own name.
                    if this.last_set.as_deref() != Some(input.read(cx).value().as_ref()) {
                        this.typed_name = true;
                    }
                    cx.notify();
                }
            }),
        ];
        Self {
            host,
            link,
            name,
            typed_name: false,
            last_set: None,
            private_only: false,
            preview: None,
            error: None,
            adding: false,
            waiting: false,
            reads: 0,
            on_added,
            _subscriptions: subscriptions,
            _read: None,
            _add: None,
            _pending: None,
        }
    }

    pub fn preview(&self) -> Option<&ComputerPreview> {
        self.preview.as_ref()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn is_adding(&self) -> bool {
        self.adding
    }

    pub fn is_waiting(&self) -> bool {
        self.waiting
    }

    pub fn link_input(&self) -> &Entity<InputState> {
        &self.link
    }

    pub fn name_input(&self) -> &Entity<InputState> {
        &self.name
    }

    pub fn set_private_only(&mut self, value: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.adding {
            self.private_only = value;
            self.read_link(window, cx);
        }
    }

    /// The link to pair with: what is typed, narrowed to private routes when that is asked for.
    fn selected_link(&self, cx: &App) -> Result<String, String> {
        let text = self.link.read(cx).value().trim().to_string();
        if text.is_empty() || !self.private_only { Ok(text) } else { private_pairing_link(&text) }
    }

    /// Reads the link again: the computer it names, or why it cannot be used.
    fn read_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reads += 1;
        let read = self.reads;
        self.preview = None;
        self.error = None;
        self._read = None;
        match self.selected_link(cx) {
            Err(message) => self.error = Some(message),
            Ok(text) if text.is_empty() => {}
            Ok(text) => {
                let future = self.host.preview_computer(&text);
                self._read = Some(call(window, cx, std::time::Duration::ZERO, future, move |this, result, window, cx| {
                    if read != this.reads {
                        return;
                    }
                    match result {
                        Ok(found) => {
                            if !this.typed_name {
                                let value = found.name.clone();
                                this.last_set = Some(value.clone());
                                this.name.update(cx, |state, cx| state.set_value(value, window, cx));
                            }
                            this.preview = Some(found);
                        }
                        Err(error) => this.error = Some(error.to_string()),
                    }
                    cx.notify();
                }));
            }
        }
        cx.notify();
    }

    pub fn paste(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item: ClipboardItem| item.text()) {
            self.paste_text(&text, window, cx);
        }
    }

    /// Puts `text` in the link field and reads it. A value set in code is not a keystroke, so the read is asked for here.
    pub fn paste_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let text = text.to_string();
        self.link.update(cx, |state, cx| state.set_value(text, window, cx));
        self.read_link(window, cx);
    }

    pub fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(preview) = self.preview.clone().filter(|_| !self.adding) else { return };
        let Ok(link) = self.selected_link(cx) else { return };
        self.adding = true;
        self.waiting = false;
        self.error = None;
        let typed = self.name.read(cx).value().trim().to_string();
        let name = if typed.is_empty() { preview.name } else { typed };
        let pending = self.host.add_pending();
        self._pending = Some(call(window, cx, STEP, pending, |this, _, _, cx| {
            if this.adding {
                this.waiting = true;
                cx.notify();
            }
        }));
        let future = self.host.add_computer(&link, &name);
        self._add = Some(call(window, cx, STEP * 2, future, move |this, result, window, cx| {
            this.adding = false;
            this.waiting = false;
            match result {
                Ok(()) => {
                    (this.on_added)(&name, cx);
                    Dialog::close(window, cx);
                }
                Err(error) => this.error = Some(error.to_string()),
            }
            cx.notify();
        }));
        cx.notify();
    }

    /// Stops a pairing under way (Cancel while waiting, or the dialog closing).
    pub fn cancel_adding(&mut self, cx: &mut Context<Self>) {
        if self.adding {
            self.host.cancel_add();
            self.adding = false;
            self.waiting = false;
            self._add = None;
            self._pending = None;
            cx.notify();
        }
    }
}

impl Render for AddComputerDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        let preview = self.preview.clone();
        let steps = [
            "On the other computer, open Milagre Settings \u{203a} Phone & sharing.",
            "Click Pair a device, then Copy link.",
            "Paste it here. The link works for 10 minutes.",
        ];

        let (lead, buttons): (Option<AnyElement>, Vec<AnyElement>) = match (&preview, self.waiting) {
            (Some(found), true) => {
                let cancel = view.clone();
                (
                    Some(
                        div()
                            .debug_selector(|| "add-computer-waiting".into())
                            .text_step(TEXT_13)
                            .text_color(theme.ink2)
                            .child(format!("Waiting for {} to allow {THIS_COMPUTER}\u{2026}", found.name))
                            .into_any_element(),
                    ),
                    vec![
                        Button::new("add-computer-cancel", "Cancel")
                            .variant(ButtonVariant::Ghost)
                            .selector("add-computer-cancel")
                            .on_click(move |_, _, cx| cancel.update(cx, |this, cx| this.cancel_adding(cx)))
                            .into_any_element(),
                    ],
                )
            }
            _ => {
                let (cancel, add) = (view.clone(), view.clone());
                (
                    None,
                    vec![
                        Button::new("add-computer-cancel", "Cancel")
                            .variant(ButtonVariant::Ghost)
                            .selector("add-computer-cancel")
                            .on_click(move |_, window, cx| {
                                cancel.update(cx, |this, cx| this.cancel_adding(cx));
                                Dialog::close(window, cx);
                            })
                            .into_any_element(),
                        Button::new("add-computer-add", if self.adding { "Connecting\u{2026}" } else { "Add computer" })
                            .disabled(preview.is_none() || self.adding)
                            .selector("add-computer-add")
                            .on_click(move |_, window, cx| add.update(cx, |this, cx| this.add(window, cx)))
                            .into_any_element(),
                    ],
                )
            }
        };

        let (paste_view, private_view) = (view.clone(), view);
        div()
            .flex()
            .flex_col()
            .child(
                div().mt(px(4.0)).flex().flex_col().gap(px(4.0)).text_step(TEXT_13).text_color(theme.ink2).children(
                    steps.iter().enumerate().map(|(ix, step)| div().flex().gap(px(6.0)).child(format!("{}.", ix + 1)).child(*step)),
                ),
            )
            .child(div().mt(px(16.0)).child(field_label("Pairing link", &theme)))
            .child(
                div()
                    .mt(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(div().min_w_0().flex_1().font_family(mono()).child(Input::new("add-computer-link", &self.link).disabled(self.adding)))
                    .child(
                        Button::new("add-computer-paste", "Paste")
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::S28)
                            .disabled(self.adding)
                            .selector("add-computer-paste")
                            .on_click(move |_, window, cx| paste_view.update(cx, |this, cx| this.paste(window, cx))),
                    ),
            )
            .child(
                div()
                    .mt(px(12.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.0))
                    .text_step(TEXT_13)
                    .child("LAN or Tailscale only")
                    .child(
                        Checkbox::new("add-computer-private", self.private_only)
                            .label("LAN or Tailscale only")
                            .disabled(self.adding)
                            .on_toggle(move |value, window, cx| private_view.update(cx, |this, cx| this.set_private_only(value, window, cx))),
                    ),
            )
            .child(div().mt(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(
                "Automatic tries private routes first. Private pairing needs both devices on the same network or tailnet.",
            ))
            .when_some(preview.clone(), |col, found| {
                col.child(
                    div()
                        .debug_selector(|| "add-computer-found".into())
                        .mt(px(12.0))
                        .flex()
                        .items_center()
                        .gap(px(12.0))
                        .p(px(12.0))
                        .rounded(RADIUS_CARD)
                        .bg(theme.hover)
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .size(px(32.0))
                                .rounded(RADIUS_CONTROL)
                                .bg(theme.hover2)
                                .child(Icon::new(IconName::Laptop).size(IconSize::S18).color(theme.ink2)),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .child(div().truncate().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child(found.name.clone()))
                                .child(
                                    div()
                                        .text_step(TEXT_12)
                                        .text_color(theme.ink3)
                                        .child(format!("Reached through {} \u{b7} end-to-end encrypted", found.relay_host)),
                                ),
                        ),
                )
                .child(div().mt(px(16.0)).child(field_label("Show it as", &theme)))
                .child(div().mt(px(6.0)).child(Input::new("add-computer-name", &self.name).disabled(self.adding)))
                .child(div().mt(px(12.0)).text_step(TEXT_12).text_color(theme.ink3).child(format!(
                    "This window gets full control of {0}\u{2019}s Projects, like its own window. Remove it any time from {0}\u{2019}s Settings \u{203a} Devices & sharing.",
                    found.name
                )))
            })
            .child(div().debug_selector(|| "add-computer-error".into()).mt(px(12.0)).child(InlineError::new(self.error.clone().unwrap_or_default()).small()))
            .child(div().mt(px(16.0)).child(footer(lead, buttons)))
    }
}

/// Opens it. `on_added` hears the name the computer was added under.
pub fn open(host: Host, on_added: impl Fn(&str, &mut App) + 'static, window: &mut Window, cx: &mut App) -> Entity<AddComputerDialog> {
    let view = cx.new(|cx| AddComputerDialog::new(host, Rc::new(on_added), window, cx));
    let (body, closing) = (view.clone(), view.clone());
    Dialog::new("Add computer")
        .description("See and drive another computer\u{2019}s Chats from this window.")
        .width(460.0)
        .body(move |_, _| body.clone().into_any_element())
        .on_close(move |_, cx| closing.update(cx, |this, cx| this.cancel_adding(cx)))
        .open(window, cx);
    view
}

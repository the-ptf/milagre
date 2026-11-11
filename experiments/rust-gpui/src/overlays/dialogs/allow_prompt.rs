//! The computer allow prompt (O-11; `ComputerAllowPrompt.tsx`): asks this computer's owner whether a computer pairing
//! for the first time may drive it. The host holds that computer's channel until Allow or Deny; two at once are asked
//! oldest first. Escape answers Deny at once, the choice that cannot give anything away; the scrim does nothing; the
//! buttons wait [`ARM_FOR`] after each new request, so the second click of a double-click on the one before cannot
//! allow it unread.

use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, IntoElement, KeyDownEvent, Render, Task, Window, div,
    prelude::*, px,
};

use super::copy::{ALLOW_DETAIL, allow_question};
use super::host::PendingComputer;
use super::{Host, call, footer};
use crate::ui::{Button, ButtonVariant, Dialog, InlineError};

/// How long a request's buttons stay off after it appears.
pub const ARM_FOR: Duration = Duration::from_millis(500);

pub struct ComputerAllowPrompt {
    host: Host,
    this_computer: String,
    requests: Vec<PendingComputer>,
    /// The key of the request whose buttons work; any other request has just appeared.
    armed: Option<String>,
    busy: bool,
    /// Tied to the request it came from, so it goes with that request.
    failure: Option<(String, String)>,
    shown: bool,
    focus: FocusHandle,
    _arm: Option<Task<()>>,
    _answer: Option<Task<()>>,
}

impl ComputerAllowPrompt {
    pub fn new(host: Host, this_computer: &str, cx: &mut Context<Self>) -> Self {
        Self {
            host,
            this_computer: this_computer.to_string(),
            requests: Vec::new(),
            armed: None,
            busy: false,
            failure: None,
            shown: false,
            focus: cx.focus_handle(),
            _arm: None,
            _answer: None,
        }
    }

    pub fn request(&self) -> Option<&PendingComputer> {
        self.requests.first()
    }

    pub fn is_armed(&self) -> bool {
        self.request().is_some_and(|request| self.armed.as_deref() == Some(request.key.as_str()))
    }

    pub fn is_shown(&self) -> bool {
        self.shown
    }

    pub fn error(&self) -> Option<&str> {
        let request = self.request()?;
        self.failure.as_ref().filter(|(key, _)| *key == request.key).map(|(_, message)| message.as_str())
    }

    /// The requests now waiting (`devices:pending`): the prompt opens for the first, changes as the list does and
    /// closes when it is empty.
    pub fn set_requests(&mut self, requests: Vec<PendingComputer>, window: &mut Window, cx: &mut Context<Self>) {
        let first_before = self.request().map(|request| request.key.clone());
        self.requests = requests;
        let first = self.request().map(|request| request.key.clone());
        if first != first_before {
            self.arm(first.clone(), cx);
        }
        match (first.is_some(), self.shown) {
            (true, false) => self.open_dialog(window, cx),
            (true, true) if first != first_before => {
                // The title is the question: the next computer gets its own dialog.
                Dialog::close(window, cx);
                self.open_dialog(window, cx);
            }
            (false, true) => {
                self.shown = false;
                Dialog::close(window, cx);
            }
            _ => {}
        }
        cx.notify();
    }

    /// Nothing is mounted until a computer waits: the dialog opens with the first request.
    fn open_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(title) = self.request().map(|request| allow_question(request.name.as_deref(), &self.this_computer)) else { return };
        self.shown = true;
        let (body, focus) = (cx.entity(), self.focus.clone());
        Dialog::new(title)
            .description(ALLOW_DETAIL)
            .width(400.0)
            .must_answer()
            .body(move |_, _| body.clone().into_any_element())
            .open(window, cx);
        window.focus(&focus, cx);
    }

    fn arm(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        self.armed = None;
        self._arm = key.map(|key| {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(ARM_FOR).await;
                this.update(cx, |this, cx| {
                    this.armed = Some(key);
                    cx.notify();
                })
                .ok();
            })
        });
    }

    pub fn answer(&mut self, allow: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(request) = self.request().cloned() else { return };
        if self.busy {
            return;
        }
        self.busy = true;
        self.failure = None;
        cx.notify();
        let future = self.host.answer_device(&request.key, allow);
        self._answer = Some(call(window, cx, Duration::ZERO, future, move |this, result, window, cx| {
            this.busy = false;
            match result {
                Ok(left) => this.set_requests(left, window, cx),
                // Most often the computer gave up meanwhile: what is still waiting is shown by the next push.
                Err(error) => this.failure = Some((request.key, error.to_string())),
            }
            cx.notify();
        }));
    }

    fn handle_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" {
            self.answer(false, window, cx);
            cx.stop_propagation();
        }
    }
}

impl Focusable for ComputerAllowPrompt {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ComputerAllowPrompt {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.request().is_none() {
            return div().into_any_element();
        }
        let off = self.busy || !self.is_armed();
        let (deny, allow) = (cx.entity(), cx.entity());
        let buttons: Vec<AnyElement> = vec![
            Button::new("allow-deny", "Deny")
                .variant(ButtonVariant::Ghost)
                .disabled(off)
                .selector("allow-deny")
                .on_click(move |_, window, cx| deny.update(cx, |this, cx| this.answer(false, window, cx)))
                .into_any_element(),
            Button::new("allow-allow", "Allow")
                .disabled(off)
                .selector("allow-allow")
                .on_click(move |_, window, cx| allow.update(cx, |this, cx| this.answer(true, window, cx)))
                .into_any_element(),
        ];
        div()
            .id("allow-prompt")
            .debug_selector(|| "allow-prompt".into())
            .key_context("ComputerAllowPrompt")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.handle_key(event, window, cx)))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(InlineError::new(self.error().unwrap_or("").to_string()).small())
            .child(footer(None, buttons))
            .into_any_element()
    }
}

/// The prompt, ready for the host's pending requests: call [`ComputerAllowPrompt::set_requests`] when they change.
pub fn new(host: Host, this_computer: &str, cx: &mut App) -> Entity<ComputerAllowPrompt> {
    cx.new(|cx| ComputerAllowPrompt::new(host, this_computer, cx))
}

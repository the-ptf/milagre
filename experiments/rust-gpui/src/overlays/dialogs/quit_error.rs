//! "Chats could not be saved" (O-14; `App.tsx`): quitting found the storage failing. A must-answer dialog: keep
//! Milagre open while the problem is fixed, then retry saving and quit. A failed retry shows the new message.

use gpui::{App, AppContext as _, Context, Entity, IntoElement, Render, SharedString, Task, Window, div, prelude::*, px};

use super::{Host, call, footer};
use crate::theme::{ActiveTheme, TEXT_13, TextStepExt};
use crate::ui::{Button, Dialog};

pub struct QuitErrorDialog {
    host: Host,
    message: SharedString,
    retrying: bool,
    _task: Option<Task<()>>,
}

impl QuitErrorDialog {
    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.retrying {
            return;
        }
        self.retrying = true;
        cx.notify();
        let future = self.host.retry_quit();
        self._task = Some(call(window, cx, std::time::Duration::ZERO, future, |this, result, window, cx| {
            this.retrying = false;
            match result {
                // The host quits the app; the dialog goes with it.
                Ok(()) => Dialog::close(window, cx),
                Err(error) => this.message = error.to_string().into(),
            }
            cx.notify();
        }));
    }
}

impl Render for QuitErrorDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let view = cx.entity();
        div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .text_step(TEXT_13)
            .child("Keep Milagre open while you fix the storage problem, then retry saving.")
            .child(div().debug_selector(|| "quit-error-message".into()).text_color(theme.ink2).child(self.message.clone()))
            .child(footer(
                None,
                vec![
                    Button::new("quit-retry", "Retry saving and quit")
                        .disabled(self.retrying)
                        .selector("quit-retry")
                        .on_click(move |_, window, cx| view.update(cx, |this, cx| this.retry(window, cx)))
                        .into_any_element(),
                ],
            ))
    }
}

/// Opens it with the error the host reported.
pub fn open(message: impl Into<SharedString>, host: Host, window: &mut Window, cx: &mut App) -> Entity<QuitErrorDialog> {
    let view = cx.new(|_| QuitErrorDialog { host, message: message.into(), retrying: false, _task: None });
    let body = view.clone();
    Dialog::new("Chats could not be saved").width(448.0).must_answer().body(move |_, _| body.clone().into_any_element()).open(window, cx);
    view
}

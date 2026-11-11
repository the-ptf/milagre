//! What the rest of the window asks of the composer: send a message for the user and keep their draft ("Fix in Chat"
//! on a PR thread, "Send to agent" from the Git dialog), or start a Chat's draft with some text (the palette's
//! "Start a new Chat with your search").

use gpui::{Context, Window};

use super::Composer;

impl Composer {
    /// Sends `text` as the user's message, the way the desktop's `executeSend` does for "Fix in Chat" and "Send to
    /// agent": it goes out like any send (steering or queued while a turn runs), and what was typed in the
    /// composer is still there afterwards. The composer takes the focus.
    pub fn send_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let draft = self.text().to_string();
        self.set_text(text, window, cx);
        self.submit(window, cx);
        if !draft.is_empty() {
            self.set_text(&draft, window, cx);
        }
        self.focus(window, cx);
    }

    /// Replaces the draft with `text`, the caret at its end, and focuses the composer.
    pub fn prefill(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.set_text(text, window, cx);
        self.focus(window, cx);
    }

    /// Puts the caret in the prompt.
    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(input) = self.input().cloned() {
            input.update(cx, |state, cx| state.focus(window, cx));
        }
    }
}

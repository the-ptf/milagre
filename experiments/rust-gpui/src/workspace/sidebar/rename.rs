//! Inline rename (`RenameField` in `components/sidebar/ChatRow.tsx`): a text field in the row's title slot, 120
//! characters at most, selected on open; Enter and blur keep the name, Escape drops it. A name emptied puts the
//! generated title back (`chat:patch { title }` with an empty title).

use gpui::{
    Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, KeyDownEvent, Render, SharedString, Subscription, Window, div,
    prelude::*,
};
use gpui_component::input::{InputEvent, InputState};

use crate::ui::Input;

/// The longest name (`maxLength={120}`).
pub const MAX_LEN: usize = 120;

pub enum RenameEvent {
    /// The name to keep (trimmed, possibly empty), or `None` when Escape dropped it.
    Finished(Option<String>),
}

pub struct RenameField {
    input: Entity<InputState>,
    done: bool,
    _subscriptions: [Subscription; 1],
}

impl EventEmitter<RenameEvent> for RenameField {}

impl RenameField {
    pub fn new(initial: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let initial: SharedString = initial.chars().take(MAX_LEN).collect::<String>().into();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(initial));
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        let events = cx.subscribe(&input, |this, input, event: &InputEvent, cx| match event {
            InputEvent::PressEnter { .. } | InputEvent::Blur => {
                let name = input.read(cx).value().trim().chars().take(MAX_LEN).collect::<String>();
                this.finish(Some(name), cx);
            }
            _ => {}
        });
        Self { input, done: false, _subscriptions: [events] }
    }

    fn finish(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        if self.done {
            return;
        }
        self.done = true;
        cx.emit(RenameEvent::Finished(name));
    }

    /// Escape: the name is dropped.
    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        self.finish(None, cx);
    }

    /// Enter: the name is kept.
    pub fn commit(&mut self, cx: &mut Context<Self>) {
        let name = self.input.read(cx).value().trim().chars().take(MAX_LEN).collect::<String>();
        self.finish(Some(name), cx);
    }

    pub fn input(&self) -> &Entity<InputState> {
        &self.input
    }
}

impl Focusable for RenameField {
    fn focus_handle(&self, cx: &gpui::App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Render for RenameField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("rename-field")
            .debug_selector(|| "rename-field".into())
            .key_context("SidebarRename")
            .w_full()
            // Consumed here, so Escape doesn't also stop the open Chat's turn.
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    this.cancel(cx);
                }
            }))
            .child(Input::new("rename-input", &self.input).bare())
    }
}

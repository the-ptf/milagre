//! Sending (`PromptComposer.tsx` `send`, `canSend`, `canStop`, `queuesFollowUp`): the decision table, the one outgoing
//! message value and the small trait the data layer implements later.
//!
//! The rules, as the React composer has them:
//!
//! - `canSend`: the draft has text, or there is a quote, an image or a file.
//! - A turn runs and nothing can be sent: the send button is Stop. With something to send it sends: a follow-up
//!   steers the running turn (label "Send now"), unless Settings › Chat says Queue, the Chat is compacting, or the
//!   provider cannot steer: then it queues (label "Queue message", placeholder "Queue a message for the next turn…").
//! - Idle: "Send". Enter sends (Shift+Enter is a newline); Enter with nothing to send does nothing, never stops.
//! - Escape reaches the window, which stops the running turn; the composer only keeps it for its own menu.

use std::cell::RefCell;
use std::path::PathBuf;

use gpui::SharedString;

pub use crate::logic::activity::queued::follow_up_delivery;

/// What a message sent while a turn runs does (`MessageDelivery`): `Now` steers the running turn, `Queue` waits.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Delivery {
    #[default]
    Now,
    Queue,
}

impl Delivery {
    /// From Settings › Chat's `followUps` value (`"now"` or `"queue"`).
    pub fn from_setting(follow_ups: Option<&str>) -> Self {
        if follow_up_delivery(follow_ups).is_some() { Delivery::Queue } else { Delivery::Now }
    }
}

/// What the send button and Enter do right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendAction {
    /// Idle: the message starts a turn.
    Send,
    /// Running and the provider steers: the message goes into the running turn.
    Steer,
    /// Running and it cannot (or should not) steer: the message waits in the queue.
    Queue,
    /// Running, nothing to send: the button stops the turn.
    Stop,
    /// Nothing to do: the button is disabled.
    Nothing,
}

/// Everything the table reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct SendState {
    pub can_send: bool,
    pub running: bool,
    pub can_steer: bool,
    pub follow_ups: Delivery,
    pub compacting: bool,
    pub blocked: bool,
}

impl SendState {
    /// `queuesFollowUp`.
    pub fn queues_follow_up(&self) -> bool {
        self.follow_ups == Delivery::Queue || self.compacting || !self.can_steer
    }

    /// What the button does: `canStop` first, then the disabled rules, then the delivery.
    pub fn button(&self) -> SendAction {
        if self.running && !self.can_send {
            return SendAction::Stop;
        }
        self.enter()
    }

    /// What Enter does: the same, but it never stops.
    pub fn enter(&self) -> SendAction {
        if !self.can_send || self.blocked {
            SendAction::Nothing
        } else if !self.running {
            SendAction::Send
        } else if self.queues_follow_up() {
            SendAction::Queue
        } else {
            SendAction::Steer
        }
    }

    /// The button's accessible label.
    pub fn label(&self) -> &'static str {
        match self.button() {
            SendAction::Stop => "Stop agent",
            _ if self.running => {
                if self.queues_follow_up() {
                    "Queue message"
                } else {
                    "Send now"
                }
            }
            _ => "Send",
        }
    }

    /// The prompt's placeholder while a turn runs, `None` when idle (the ordinary one).
    pub fn running_placeholder(&self) -> Option<&'static str> {
        self.running.then(|| if self.queues_follow_up() { "Queue a message for the next turn\u{2026}" } else { "Steer the agent\u{2026}" })
    }
}

/// An attachment as the message carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct OutgoingAttachment {
    pub name: SharedString,
    /// The file on this computer; `None` for a pasted image that was never saved.
    pub path: Option<PathBuf>,
}

/// An image the prompt mentions as `[Image #index]` (1-based).
#[derive(Clone, Debug, PartialEq)]
pub struct OutgoingImage {
    pub index: u64,
    pub name: SharedString,
    pub path: Option<PathBuf>,
    /// The picture as `ImageAttachment.dataUrl` (`data:image/png;base64,...`), what `chat:send` carries; `None`
    /// when its bytes could not be read.
    pub data_url: Option<String>,
}

/// The one value a send produces.
#[derive(Clone, Debug, PartialEq)]
pub struct OutgoingMessage {
    /// What goes to the agent: the quotes as blockquotes, then the typed prompt.
    pub prompt: String,
    /// The typed prompt alone.
    pub text: String,
    /// The quoted passages, in order.
    pub quotes: Vec<String>,
    /// Files that are not images (an image's file is in `images`).
    pub files: Vec<OutgoingAttachment>,
    pub images: Vec<OutgoingImage>,
    pub delivery: SendAction,
    /// What the bar showed at the send: the model chip's provider and model id, and the permission mode.
    pub provider: crate::data::Provider,
    pub model: SharedString,
    pub permission: crate::data::PermissionMode,
    /// On the new-Chat screen: where the Chat starts (the tray's Project, isolation, Worktree or branch, and the Linear
    /// issue it starts from), read at the send, before the screen gives way to the Chat.
    pub new_chat: Option<Box<super::new_chat::NewChatChoice>>,
}

/// The data layer's side of the composer: a send, the Stop button, and the queue's Send now and Remove.
pub trait MessageSink {
    fn send(&self, message: OutgoingMessage);
    fn stop(&self);
    fn send_queued_now(&self, id: &str);
    fn remove_queued(&self, id: &str);
}

/// A recorded call on [`FixtureSink`].
#[derive(Clone, Debug, PartialEq)]
pub enum SinkCall {
    Send(OutgoingMessage),
    Stop,
    SendQueuedNow(String),
    RemoveQueued(String),
}

/// Records every call, for tests and the snapshot.
#[derive(Default)]
pub struct FixtureSink {
    calls: RefCell<Vec<SinkCall>>,
}

impl FixtureSink {
    pub fn calls(&self) -> Vec<SinkCall> {
        self.calls.borrow().clone()
    }
}

impl MessageSink for FixtureSink {
    fn send(&self, message: OutgoingMessage) {
        self.calls.borrow_mut().push(SinkCall::Send(message));
    }
    fn stop(&self) {
        self.calls.borrow_mut().push(SinkCall::Stop);
    }
    fn send_queued_now(&self, id: &str) {
        self.calls.borrow_mut().push(SinkCall::SendQueuedNow(id.to_string()));
    }
    fn remove_queued(&self, id: &str) {
        self.calls.borrow_mut().push(SinkCall::RemoveQueued(id.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(can_send: bool, running: bool, can_steer: bool, follow_ups: Delivery) -> SendState {
        SendState { can_send, running, can_steer, follow_ups, ..SendState::default() }
    }

    #[test]
    fn the_send_decision_table() {
        use Delivery::{Now, Queue};
        use SendAction::{Nothing, Queue as Q, Send, Steer, Stop};
        // (can_send, running, can_steer, setting) -> (button, enter)
        let table = [
            (false, false, true, Now, Nothing, Nothing),
            (true, false, true, Now, Send, Send),
            (true, false, false, Queue, Send, Send),
            (false, true, true, Now, Stop, Nothing),
            (true, true, true, Now, Steer, Steer),
            (true, true, true, Queue, Q, Q),
            (true, true, false, Now, Q, Q),
            (false, true, false, Queue, Stop, Nothing),
        ];
        for (can_send, running, can_steer, setting, button, enter) in table {
            let s = state(can_send, running, can_steer, setting);
            assert_eq!((s.button(), s.enter()), (button, enter), "{s:?}");
        }
    }

    #[test]
    fn compacting_and_a_blocked_composer_queue_or_wait() {
        let compacting = SendState { compacting: true, ..state(true, true, true, Delivery::Now) };
        assert_eq!(compacting.enter(), SendAction::Queue);
        let blocked = SendState { blocked: true, ..state(true, false, true, Delivery::Now) };
        assert_eq!(blocked.enter(), SendAction::Nothing);
        // Stop is not blocked by it (`canStop` ignores sendBlocked).
        let blocked_stop = SendState { blocked: true, ..state(false, true, true, Delivery::Now) };
        assert_eq!(blocked_stop.button(), SendAction::Stop);
    }

    #[test]
    fn labels_and_placeholders_follow_the_state() {
        assert_eq!(state(true, false, true, Delivery::Now).label(), "Send");
        assert_eq!(state(true, true, true, Delivery::Now).label(), "Send now");
        assert_eq!(state(true, true, true, Delivery::Queue).label(), "Queue message");
        assert_eq!(state(false, true, true, Delivery::Now).label(), "Stop agent");
        assert_eq!(state(true, false, true, Delivery::Now).running_placeholder(), None);
        assert_eq!(state(true, true, true, Delivery::Now).running_placeholder(), Some("Steer the agent\u{2026}"));
        assert_eq!(state(true, true, false, Delivery::Now).running_placeholder(), Some("Queue a message for the next turn\u{2026}"));
    }

    #[test]
    fn the_setting_maps_to_a_delivery() {
        assert_eq!(Delivery::from_setting(Some("queue")), Delivery::Queue);
        assert_eq!(Delivery::from_setting(Some("now")), Delivery::Now);
        assert_eq!(Delivery::from_setting(None), Delivery::Now);
    }
}

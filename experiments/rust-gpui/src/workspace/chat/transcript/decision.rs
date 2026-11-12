//! What the user decided on an approval or question card, as an event a data layer answers the agent with.
//!
//! The cards resolve in place (`Transcript::resolve`, the question card's Send answer and Dismiss) and then emit one
//! [`CardDecision`]. The transcript does not know which request an item stands for beyond what the card holds: an
//! approval is named by its item index (the layer that pushed it keeps the request id), a question by its own
//! `request_id`. The fixture app subscribes to nothing, so the event is only heard where a data layer listens.

use gpui::SharedString;

use super::{ApprovalState, Transcript};

#[derive(Clone, Debug, PartialEq)]
pub enum CardDecision {
    /// The approval at item `ix` was answered: `Allowed` (Allow once), `AlwaysAllowed` (Always allow in this Chat)
    /// or `Denied`.
    Approval { ix: usize, state: ApprovalState },
    /// The question card at item `ix` was sent (`answers` by question id, each with its chosen labels or typed text)
    /// or dismissed (`answers` is `None`).
    Question { ix: usize, request_id: SharedString, answers: Option<Vec<(String, Vec<String>)>> },
}

impl gpui::EventEmitter<CardDecision> for Transcript {}

//! The input queue (`createSimulatorInputQueue` in `shared/simulator-receiver.mjs`): one RPC in flight at a time,
//! consecutive moves of the same contact count collapse into the newest, a gesture boundary is never dropped, and
//! a backlog past the limit ends the session ("Connection is too slow for input").

use std::collections::VecDeque;

use super::types::{Input, TouchPhase};

/// How many events may wait before the session is ended.
pub const QUEUE_LIMIT: usize = 32;

pub const TOO_SLOW: &str = "Connection is too slow for input. Retry the simulator.";

#[derive(Debug, Default)]
pub struct InputQueue {
    queue: VecDeque<Input>,
    sending: bool,
}

/// The backlog passed [`QUEUE_LIMIT`]; the queue is now empty and the session must end.
#[derive(Debug, PartialEq, Eq)]
pub struct Overflow;

impl InputQueue {
    /// Queues `event`, or replaces the last queued event when both are moves of the same contact count.
    pub fn push(&mut self, event: Input) -> Result<(), Overflow> {
        if let (Input::Touch { phase: TouchPhase::Move, points }, Some(Input::Touch { phase: TouchPhase::Move, points: last })) =
            (&event, self.queue.back())
            && points.len() == last.len()
        {
            *self.queue.back_mut().expect("checked above") = event;
            return Ok(());
        }
        if self.queue.len() >= QUEUE_LIMIT {
            self.clear();
            return Err(Overflow);
        }
        self.queue.push_back(event);
        Ok(())
    }

    /// The next event to send, when none is in flight. The caller calls [`InputQueue::sent`] once it is answered.
    pub fn take(&mut self) -> Option<Input> {
        if self.sending {
            return None;
        }
        let event = self.queue.pop_front()?;
        self.sending = true;
        Some(event)
    }

    pub fn sent(&mut self) {
        self.sending = false;
    }

    /// Drops what is waiting (lost control, a new display generation, a closed viewer). An event in flight stays
    /// in flight; its answer is ignored by the caller's epoch check.
    pub fn clear(&mut self) {
        self.queue.clear();
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

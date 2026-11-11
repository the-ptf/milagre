//! An event queue with a memory budget that never blocks its producer.
//!
//! The transport's reader must keep reading while a consumer awaits a request's answer (the answer
//! arrives on the same pipe), so a queue that blocked the reader when full could deadlock a consumer
//! that waits on a request before draining events. Instead the producer is told when the budget is
//! exceeded and stops the source (the transport kills Codex), so memory stays bounded and nothing
//! is silently dropped. A final event can still be forced in past the budget.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueLimits {
    /// Events waiting to be received.
    pub max_events: usize,
    /// Sum of the sizes given to [`EventSender::send`] for events waiting to be received.
    pub max_bytes: usize,
}

impl Default for QueueLimits {
    fn default() -> Self {
        QueueLimits { max_events: 100_000, max_bytes: 256 * 1024 * 1024 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overflow {
    pub queued_events: usize,
    pub queued_bytes: usize,
}

struct Shared {
    limits: QueueLimits,
    events: AtomicUsize,
    bytes: AtomicUsize,
    overflowed: AtomicBool,
}

pub struct EventSender<T> {
    tx: mpsc::UnboundedSender<(T, usize)>,
    shared: Arc<Shared>,
}

impl<T> Clone for EventSender<T> {
    fn clone(&self) -> Self {
        EventSender { tx: self.tx.clone(), shared: self.shared.clone() }
    }
}

pub struct EventReceiver<T> {
    rx: mpsc::UnboundedReceiver<(T, usize)>,
    shared: Arc<Shared>,
}

pub fn channel<T>(limits: QueueLimits) -> (EventSender<T>, EventReceiver<T>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Shared { limits, events: AtomicUsize::new(0), bytes: AtomicUsize::new(0), overflowed: AtomicBool::new(false) });
    (EventSender { tx, shared: shared.clone() }, EventReceiver { rx, shared })
}

impl<T> EventSender<T> {
    /// Queues an event of about `bytes` bytes. Fails without queueing when the budget would be
    /// exceeded; from then on the queue counts as overflowed. A closed receiver is not an error.
    pub fn send(&self, event: T, bytes: usize) -> Result<(), Overflow> {
        let events = self.shared.events.load(Ordering::Acquire);
        let queued = self.shared.bytes.load(Ordering::Acquire);
        if events + 1 > self.shared.limits.max_events || queued.saturating_add(bytes) > self.shared.limits.max_bytes {
            self.shared.overflowed.store(true, Ordering::Release);
            return Err(Overflow { queued_events: events, queued_bytes: queued });
        }
        self.force(event, bytes);
        Ok(())
    }

    /// Queues past the budget (a final event).
    pub fn force(&self, event: T, bytes: usize) {
        self.shared.events.fetch_add(1, Ordering::AcqRel);
        self.shared.bytes.fetch_add(bytes, Ordering::AcqRel);
        if self.tx.send((event, bytes)).is_err() {
            self.shared.events.fetch_sub(1, Ordering::AcqRel);
            self.shared.bytes.fetch_sub(bytes, Ordering::AcqRel);
        }
    }

    pub fn overflowed(&self) -> bool {
        self.shared.overflowed.load(Ordering::Acquire)
    }

    pub fn queued(&self) -> (usize, usize) {
        (self.shared.events.load(Ordering::Acquire), self.shared.bytes.load(Ordering::Acquire))
    }
}

impl<T> EventReceiver<T> {
    pub async fn recv(&mut self) -> Option<T> {
        let (event, bytes) = self.rx.recv().await?;
        self.release(bytes);
        Some(event)
    }

    pub fn try_recv(&mut self) -> Result<T, mpsc::error::TryRecvError> {
        let (event, bytes) = self.rx.try_recv()?;
        self.release(bytes);
        Ok(event)
    }

    fn release(&self, bytes: usize) {
        self.shared.events.fetch_sub(1, Ordering::AcqRel);
        self.shared.bytes.fetch_sub(bytes, Ordering::AcqRel);
    }

    /// Events waiting, and their bytes.
    pub fn queued(&self) -> (usize, usize) {
        (self.shared.events.load(Ordering::Acquire), self.shared.bytes.load(Ordering::Acquire))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn budget_counts_both_ways() {
        let (tx, mut rx) = channel::<u32>(QueueLimits { max_events: 2, max_bytes: 100 });
        tx.send(1, 10).unwrap();
        tx.send(2, 10).unwrap();
        assert_eq!(tx.send(3, 10), Err(Overflow { queued_events: 2, queued_bytes: 20 }));
        assert!(tx.overflowed());
        tx.force(4, 10);
        assert_eq!(rx.recv().await, Some(1));
        assert_eq!(rx.queued(), (2, 20));
        assert_eq!(tx.send(5, 200).unwrap_err().queued_bytes, 20);
        assert_eq!(rx.recv().await, Some(2));
        assert_eq!(rx.recv().await, Some(4));
        assert_eq!(rx.queued(), (0, 0));
    }
}

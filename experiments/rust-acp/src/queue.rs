//! Budgeted nonblocking event delivery. Producers reserve under one lock, including concurrent
//! stdout/stderr producers. Overflow or receiver loss tells the transport to stop the source.
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueLimits {
    pub max_events: usize,
    pub max_bytes: usize,
}
impl Default for QueueLimits {
    fn default() -> Self {
        Self { max_events: 4096, max_bytes: 16 * 1024 * 1024 }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overflow {
    pub queued_events: usize,
    pub queued_bytes: usize,
}
struct Budget {
    limits: QueueLimits,
    events: usize,
    bytes: usize,
    overflowed: bool,
}
pub struct EventSender<T> {
    tx: mpsc::UnboundedSender<(T, usize)>,
    shared: Arc<Mutex<Budget>>,
}
pub struct EventReceiver<T> {
    rx: mpsc::UnboundedReceiver<(T, usize)>,
    shared: Arc<Mutex<Budget>>,
}
impl<T> Clone for EventSender<T> {
    fn clone(&self) -> Self {
        Self { tx: self.tx.clone(), shared: self.shared.clone() }
    }
}
pub fn channel<T>(limits: QueueLimits) -> (EventSender<T>, EventReceiver<T>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let shared = Arc::new(Mutex::new(Budget { limits, events: 0, bytes: 0, overflowed: false }));
    (EventSender { tx, shared: shared.clone() }, EventReceiver { rx, shared })
}
impl<T> EventSender<T> {
    pub fn send(&self, event: T, bytes: usize) -> Result<(), Overflow> {
        let mut state = self.shared.lock().unwrap();
        if self.tx.is_closed()
            || state.overflowed
            || state.events >= state.limits.max_events
            || bytes > state.limits.max_bytes.saturating_sub(state.bytes)
        {
            state.overflowed = true;
            return Err(Overflow { queued_events: state.events, queued_bytes: state.bytes });
        }
        if self.tx.send((event, bytes)).is_err() {
            state.overflowed = true;
            return Err(Overflow { queued_events: state.events, queued_bytes: state.bytes });
        }
        state.events += 1;
        state.bytes += bytes;
        Ok(())
    }
    /// Reserved terminal delivery outside the normal budget. Transport uses exactly one exit;
    /// the fake session seals admission first and uses at most admitted turns + open permissions +
    /// one closed event. Never use this for ordinary data or an unbounded producer.
    pub(crate) fn force(&self, event: T, bytes: usize) {
        let mut state = self.shared.lock().unwrap();
        if self.tx.send((event, bytes)).is_ok() {
            state.events += 1;
            state.bytes += bytes;
        }
    }
    pub fn queued(&self) -> (usize, usize) {
        let s = self.shared.lock().unwrap();
        (s.events, s.bytes)
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
        let mut s = self.shared.lock().unwrap();
        s.events -= 1;
        s.bytes -= bytes;
    }
    pub fn queued(&self) -> (usize, usize) {
        let s = self.shared.lock().unwrap();
        (s.events, s.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_producers_share_one_exact_budget() {
        let (tx, mut rx) = channel(QueueLimits { max_events: 32, max_bytes: 128 });
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let jobs: Vec<_> = (0..4)
            .map(|n| {
                let tx = tx.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for _ in 0..100 {
                        let _ = tx.send(n, 4);
                    }
                })
            })
            .collect();
        for job in jobs {
            job.join().unwrap();
        }
        assert_eq!(tx.queued(), (32, 128));
        let mut count = 0;
        while rx.try_recv().is_ok() {
            count += 1;
        }
        assert_eq!(count, 32);
        assert_eq!(rx.queued(), (0, 0));
        assert!(tx.send(1, 1).is_err(), "overflow stays sealed");
        tx.force(99, 0);
        assert_eq!(rx.try_recv().unwrap(), 99);
    }
}

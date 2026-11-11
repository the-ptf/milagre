use crate::{protocol, ClientOptions, Error, Notice, Result};
use std::{
    collections::VecDeque,
    future::poll_fn,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
};

struct State {
    ready: VecDeque<(Notice, usize)>,
    held: VecDeque<(Notice, usize)>,
    bytes: usize,
    holding: bool,
    closed: Option<Error>,
    ended: bool,
    waker: Option<Waker>,
}
pub(crate) struct Queue {
    state: Mutex<State>,
    max_count: usize,
    max_bytes: usize,
}
impl Queue {
    pub(crate) fn new(options: &ClientOptions) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                ready: VecDeque::new(),
                held: VecDeque::new(),
                bytes: 0,
                holding: true,
                closed: None,
                ended: false,
                waker: None,
            }),
            max_count: options.max_notification_events,
            max_bytes: options.max_notification_bytes,
        })
    }
    pub(crate) fn push(&self, event: Notice, bytes: usize) -> Result<()> {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.closed.is_some() || s.ended {
                return Err(Error::Disconnected);
            }
            if s.ready.len() + s.held.len() >= self.max_count
                || bytes > self.max_bytes.saturating_sub(s.bytes)
            {
                return Err(protocol("notification buffer overflow"));
            }
            s.bytes += bytes;
            if s.holding {
                s.held.push_back((event, bytes));
                None
            } else {
                s.ready.push_back((event, bytes));
                s.waker.take()
            }
        };
        if let Some(waker) = wake {
            waker.wake();
        }
        Ok(())
    }
    pub(crate) fn hold(&self) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        s.holding = true;
        let mut ready = std::mem::take(&mut s.ready);
        ready.append(&mut s.held);
        s.held = ready;
    }
    pub(crate) fn release(&self, watermark: u64) {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            while let Some((event, bytes)) = s.held.pop_front() {
                if matches!(&event, Notice::Event { wire_seq, .. } if *wire_seq <= watermark) {
                    s.bytes -= bytes;
                } else {
                    s.ready.push_back((event, bytes));
                }
            }
            s.holding = false;
            s.waker.take()
        };
        if let Some(waker) = wake {
            waker.wake();
        }
    }
    pub(crate) fn close(&self, error: Error) {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.closed.is_some() || s.ended {
                return;
            }
            // Events held behind an unaccepted snapshot cannot be delivered safely.
            let held_bytes: usize = s.held.drain(..).map(|(_, bytes)| bytes).sum();
            s.bytes -= held_bytes;
            s.closed = Some(error);
            s.waker.take()
        };
        if let Some(waker) = wake {
            waker.wake();
        }
    }
}

/// One ordered consumer. Terminal failure is delivered once, after any already released prefix.
pub struct Notifications {
    pub(crate) queue: Arc<Queue>,
}
impl Notifications {
    pub async fn next(&mut self) -> Option<Notice> {
        poll_fn(|cx| {
            let mut s = self.queue.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((event, bytes)) = s.ready.pop_front() {
                s.bytes -= bytes;
                return Poll::Ready(Some(event));
            }
            if let Some(error) = s.closed.take() {
                s.ended = true;
                return Poll::Ready(Some(Notice::Closed(error)));
            }
            if s.ended {
                return Poll::Ready(None);
            }
            s.waker = Some(cx.waker().clone());
            Poll::Pending
        })
        .await
    }
}

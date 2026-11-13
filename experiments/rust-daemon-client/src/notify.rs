use crate::{protocol, ClientOptions, Error, Notice, Result};
use serde_json::Value;
use std::{
    collections::VecDeque,
    future::poll_fn,
    sync::{Arc, Mutex},
    task::{Poll, Waker},
    time::{Duration, Instant},
};

struct Entry {
    event: Notice,
    bytes: usize,
    hydrate: bool,
    expires: Option<Instant>,
}
impl Entry {
    fn oversized(&self) -> bool {
        matches!(&self.event, Notice::Event { payload, .. } if payload["stateTooLarge"] == true)
    }
}
struct State {
    ready: VecDeque<Entry>,
    held: VecDeque<Entry>,
    bytes: usize,
    holding: bool,
    /// Set by [`Notifications::discard`]: events are dropped on arrival, never buffered.
    discarding: bool,
    hydration_scope: Option<String>,
    closed: Option<Error>,
    ended: bool,
    waker: Option<Waker>,
}
impl State {
    fn release_ready(&mut self) -> Option<Waker> {
        if self.holding {
            return None;
        }
        while self.held.front().is_some_and(|entry| !entry.hydrate) {
            self.ready.push_back(self.held.pop_front().unwrap());
        }
        if self.held.is_empty() {
            self.hydration_scope = None;
        }
        if self.ready.is_empty() {
            None
        } else {
            self.waker.take()
        }
    }
}
pub(crate) struct Batch {
    pub(crate) scope: Option<String>,
    pub(crate) through: u64,
    pub(crate) expires: Instant,
}
pub(crate) struct Queue {
    state: Mutex<State>,
    max_count: usize,
    max_bytes: usize,
    timeout: Duration,
}
impl Queue {
    pub(crate) fn new(options: &ClientOptions) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                ready: VecDeque::new(),
                held: VecDeque::new(),
                bytes: 0,
                holding: true,
                discarding: false,
                hydration_scope: None,
                closed: None,
                ended: false,
                waker: None,
            }),
            max_count: options.max_notification_events,
            max_bytes: options.max_notification_bytes,
            timeout: options.request_timeout,
        })
    }
    pub(crate) fn push(&self, event: Notice, bytes: usize) -> Result<()> {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.closed.is_some() || s.ended {
                return Err(Error::Disconnected);
            }
            if s.discarding {
                return Ok(());
            }
            if s.ready.len() + s.held.len() >= self.max_count
                || bytes > self.max_bytes.saturating_sub(s.bytes)
            {
                return Err(protocol("notification buffer overflow"));
            }
            let hydrate = matches!(&event, Notice::Event { scope, payload, .. }
                if payload["stateTooLarge"] == true
                    || (s.hydration_scope.is_some() && *scope == s.hydration_scope && payload["state"].is_object()));
            let expires = (hydrate && !s.holding).then(|| Instant::now() + self.timeout);
            s.bytes += bytes;
            s.held.push_back(Entry {
                event,
                bytes,
                hydrate,
                expires,
            });
            s.release_ready()
        };
        if let Some(waker) = wake {
            waker.wake();
        }
        Ok(())
    }
    pub(crate) fn hold(&self) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        s.holding = true;
        s.hydration_scope = None;
        let mut ready = std::mem::take(&mut s.ready);
        ready.append(&mut s.held);
        for entry in &mut ready {
            entry.hydrate = entry.oversized();
            entry.expires = None;
        }
        s.held = ready;
    }
    pub(crate) fn release(&self, watermark: u64) {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let mut retained = VecDeque::new();
            let expires = Instant::now() + self.timeout;
            while let Some(mut entry) = s.held.pop_front() {
                if matches!(&entry.event, Notice::Event { wire_seq, .. } if *wire_seq <= watermark)
                {
                    s.bytes -= entry.bytes;
                } else {
                    entry.expires = entry.hydrate.then_some(expires);
                    retained.push_back(entry);
                }
            }
            s.held = retained;
            s.holding = false;
            s.release_ready()
        };
        if let Some(waker) = wake {
            waker.wake();
        }
    }
    /// Freeze an already charged prefix. Nothing is removed or released during its read.
    pub(crate) fn hydration(&self) -> Option<Batch> {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.holding || s.closed.is_some() || s.ended {
            return None;
        }
        let first = s.held.front()?;
        let Notice::Event { scope, .. } = &first.event else {
            return None;
        };
        let scope = scope.clone();
        let expires = first.expires?;
        let Notice::Event { wire_seq, .. } = &s.held.back()?.event else {
            return None;
        };
        let through = *wire_seq;
        s.hydration_scope = scope.clone();
        Some(Batch {
            scope,
            through,
            expires,
        })
    }
    pub(crate) fn hydrated(&self, batch: Batch, state: Value) -> Result<()> {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.closed.is_some() || s.ended {
                return Err(Error::Disconnected);
            }
            let state_bytes = state.to_string().len();
            if state_bytes > self.max_bytes {
                return Err(protocol("notification buffer overflow during hydration"));
            }
            let mut replacements = Vec::new();
            let mut total = s.bytes;
            // Same frozen-batch state replacement as runtime-client.cjs/transport.rs,
            // but keep every envelope and block the entire global suffix.
            for (index, entry) in s.held.iter().enumerate() {
                let Notice::Event {
                    wire_seq,
                    scope,
                    payload,
                    ..
                } = &entry.event
                else {
                    continue;
                };
                if *wire_seq > batch.through {
                    break;
                }
                if *scope != batch.scope || !(entry.hydrate || payload["state"].is_object()) {
                    continue;
                }
                let mut base = payload.clone();
                let object = base
                    .as_object_mut()
                    .ok_or_else(|| protocol("invalid hydration payload"))?;
                object.remove("stateTooLarge");
                object.remove("state");
                let base_bytes = base.to_string().len();
                // JSON object braces remain; the new member is `"state":` plus
                // the serialized state and a comma if another member exists.
                let payload_bytes = base_bytes + 8 + state_bytes + usize::from(base_bytes > 2);
                let bytes = entry.bytes - payload.to_string().len() + payload_bytes;
                total = total - entry.bytes + bytes;
                if total > self.max_bytes {
                    return Err(protocol("notification buffer overflow during hydration"));
                }
                replacements.push((index, base, bytes));
            }
            // Preflight all growth before cloning a full state into any envelope.
            for (index, mut payload, bytes) in replacements {
                payload
                    .as_object_mut()
                    .unwrap()
                    .insert("state".into(), state.clone());
                let entry = &mut s.held[index];
                if let Notice::Event {
                    payload: target, ..
                } = &mut entry.event
                {
                    *target = payload;
                }
                entry.bytes = bytes;
                entry.hydrate = false;
                entry.expires = None;
            }
            s.bytes = total;
            s.release_ready()
        };
        if let Some(waker) = wake {
            waker.wake();
        }
        Ok(())
    }
    pub(crate) fn close(&self, error: Error) {
        let wake = {
            let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if s.closed.is_some() || s.ended {
                return;
            }
            // Neither snapshot-held nor unhydrated suffixes can be delivered safely.
            let held_bytes: usize = s.held.drain(..).map(|entry| entry.bytes).sum();
            s.bytes -= held_bytes;
            s.hydration_scope = None;
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
    /// For a connection that only makes requests (terminal reads, Git reads, actions) and never applies state: drop
    /// every event from now on instead of buffering it until a snapshot. Without this, an unread connection fills its
    /// bounded buffer and closes. Already buffered events are dropped too.
    #[cfg(feature = "installed-owner")]
    pub fn discard(self) {
        let mut s = self.queue.state.lock().unwrap_or_else(|p| p.into_inner());
        s.discarding = true;
        s.ready.clear();
        s.held.clear();
        s.bytes = 0;
    }
    pub async fn next(&mut self) -> Option<Notice> {
        poll_fn(|cx| {
            let mut s = self.queue.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(entry) = s.ready.pop_front() {
                s.bytes -= entry.bytes;
                return Poll::Ready(Some(entry.event));
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

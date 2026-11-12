//! The snapshot barrier at the GPUI edge: connect, take `runtime_snapshot()`, apply it to a [`Reducer`], then
//! `accept_snapshot(&snapshot)`, and only then read released events.
//!
//! The reducer holds the applied snapshot decoded into GPUI types, then applies each released event in `wire_seq`
//! order (`crate::live`: `project:state`, `agent:event`) and records it in a bounded tail. [`LiveStore`] is the seam a
//! view subscribes to (a version counter and a read accessor); nothing in the GPUI app is wired to it yet.
//! A closed stream is an error, never an empty state: once `Notice::Closed` arrives, [`Reducer::state`] answers that
//! error (`StateTooLarge` with its required `project:read`, or the client's reason).

use milagre_daemon_client::{Client, ClientOptions, Error, FixtureEndpoint, Hello, Notice, Notifications, RuntimeSnapshot};
use milagre_gpui_spike::data::{ChatRuns, OpenProject};
use std::collections::VecDeque;

use serde_json::Value;

pub use crate::live::check_runs;
use crate::live::{Counts, Effect, Live, LiveBounds};
use crate::{DaemonAdapter, map};

/// The snapshot as applied: every open Project with its state, and the runs, in GPUI types.
#[derive(Clone, Debug)]
pub struct Applied {
    /// The global wire watermark (`eventSeq`) the snapshot was captured at.
    pub event_seq: u64,
    pub projects: Vec<OpenProject>,
    pub runs: ChatRuns,
    /// `links`, counted only: Links are not mapped in this stage.
    pub links: usize,
}

/// An event the client released after the accepted snapshot, recorded as sent (not applied).
#[derive(Clone, Debug, PartialEq)]
pub struct ReleasedEvent {
    pub wire_seq: u64,
    pub scope: Option<String>,
    pub channel: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SyncError {
    /// An event arrived before any snapshot was applied.
    NotApplied,
    /// The client released an event at or below the accepted watermark (it must have discarded it).
    StaleEvent { wire_seq: u64, watermark: u64 },
    /// An event at or below the last applied one, above the watermark: a regression. Refused, not applied.
    OutOfOrder { wire_seq: u64, last: u64 },
    /// A known channel whose payload does not have the shape the owner sends. Closes the live state.
    InvalidEvent { channel: String, message: String },
    /// The live state would cross one of its bounds (`live::LiveBounds`). Closes the live state.
    Bound { what: &'static str, limit: usize },
    /// An oversized Project event closed the connection: the scope must be read again with `method`.
    StateTooLarge { scope: Option<String>, method: Option<String> },
    /// The connection closed for another reason.
    Closed(Error),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::StateTooLarge { scope, method } => write!(
                f,
                "the Project's state is too large to stream: read {} again with {}",
                scope.as_deref().unwrap_or("its scope"),
                method.as_deref().unwrap_or("project:read")
            ),
            other => write!(f, "{other:?}"),
        }
    }
}

impl std::error::Error for SyncError {}

/// The released events kept for inspection: how many arrived since the snapshot was applied, and the newest of them
/// within the client's own notification bounds (`ClientOptions::default()`: 1,024 events, 16 MiB of serialized
/// payload). Older ones are dropped from the tail, never from the count, so the record cannot grow without bound.
#[derive(Clone, Debug)]
pub struct Released {
    count: u64,
    tail: VecDeque<(ReleasedEvent, usize)>,
    bytes: usize,
    max_events: usize,
    max_bytes: usize,
}

impl Released {
    /// Hard caps: the tail never holds more than `max_events` events or `max_bytes` payload bytes. An event larger
    /// than `max_bytes` on its own is counted but not kept (the tail is left as it was); zero capacity keeps nothing.
    pub fn with_bounds(max_events: usize, max_bytes: usize) -> Self {
        Self { count: 0, tail: VecDeque::new(), bytes: 0, max_events, max_bytes }
    }

    fn push(&mut self, event: ReleasedEvent) {
        self.count += 1;
        let size = event.payload.to_string().len();
        if self.max_events == 0 || size > self.max_bytes {
            return;
        }
        while self.tail.len() >= self.max_events || self.bytes + size > self.max_bytes {
            let (_, dropped) = self.tail.pop_front().expect("a non-empty tail while over a bound");
            self.bytes -= dropped;
        }
        self.bytes += size;
        self.tail.push_back((event, size));
    }

    fn clear(&mut self) {
        self.count = 0;
        self.tail.clear();
        self.bytes = 0;
    }

    /// Every event released since the snapshot was applied, including those no longer in the tail.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// The newest events kept, oldest first.
    pub fn tail(&self) -> impl ExactSizeIterator<Item = &ReleasedEvent> {
        self.tail.iter().map(|(event, _)| event)
    }

    /// Serialized payload bytes the tail holds.
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

impl Default for Released {
    fn default() -> Self {
        let client = ClientOptions::default();
        Self::with_bounds(client.max_notification_events, client.max_notification_bytes)
    }
}

/// `Date.now()` as the run fold reads it.
pub type Clock = std::sync::Arc<dyn Fn() -> i64 + Send + Sync>;

fn system_clock() -> Clock {
    std::sync::Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64))
}

pub struct Reducer {
    applied: Option<Applied>,
    released: Released,
    closed: Option<SyncError>,
    /// The last applied `wire_seq` (the watermark right after a snapshot).
    last_seq: u64,
    counts: Counts,
    bounds: LiveBounds,
    /// +1 for every change a view would show: a snapshot, an applied event, a close.
    version: u64,
    clock: Clock,
}

impl Default for Reducer {
    fn default() -> Self {
        Self {
            applied: None,
            released: Released::default(),
            closed: None,
            last_seq: 0,
            counts: Counts::default(),
            bounds: LiveBounds::default(),
            version: 0,
            clock: system_clock(),
        }
    }
}

impl Reducer {
    /// Decodes and holds `snapshot`. Call before `accept_snapshot`; a snapshot that does not decode is not accepted.
    pub fn apply_snapshot(&mut self, snapshot: &RuntimeSnapshot) -> anyhow::Result<&Applied> {
        self.apply_body(&snapshot.body, snapshot.event_seq)
    }

    /// [`Self::apply_snapshot`] on a snapshot body and its watermark (tests use captured bodies).
    pub(crate) fn apply_body(&mut self, body: &Value, event_seq: u64) -> anyhow::Result<&Applied> {
        if body["eventSeq"].as_u64() != Some(event_seq) {
            anyhow::bail!("snapshot eventSeq does not match its watermark {event_seq}");
        }
        let projects = body["projects"].as_array().ok_or_else(|| anyhow::anyhow!("snapshot.projects: expected an array"))?;
        let projects = projects.iter().map(map::open_project).collect::<anyhow::Result<Vec<_>>>()?;
        let runs = &body["runs"];
        let seq = runs["seq"].as_u64().ok_or_else(|| anyhow::anyhow!("snapshot.runs.seq: expected an unsigned integer"))?;
        let runs = map::chat_runs(&milagre_daemon_client::ChatRuns { runs: runs["runs"].clone(), seq })?;
        let links = body["links"].as_array().ok_or_else(|| anyhow::anyhow!("snapshot.links: expected an array"))?.len();
        // The snapshot's runs are held under the same hard bounds as live ones; a refused snapshot changes nothing.
        crate::live::check_runs(&runs, self.bounds)?;
        self.released.clear();
        self.closed = None;
        self.last_seq = event_seq;
        self.counts = Counts::default();
        self.version += 1;
        Ok(self.applied.insert(Applied { event_seq, projects, runs, links }))
    }

    /// Takes one notice the client released. An event above the last applied one is recorded in the bounded tail and
    /// applied to the live state; `Closed`, an invalid payload or a crossed bound latches its error.
    pub fn apply_notice(&mut self, notice: Notice) -> Result<Effect, SyncError> {
        if let Some(closed) = &self.closed {
            return Err(closed.clone());
        }
        match notice {
            Notice::Event { wire_seq, scope, channel, payload } => {
                let Some(applied) = &mut self.applied else { return Err(SyncError::NotApplied) };
                if wire_seq <= applied.event_seq {
                    return Err(SyncError::StaleEvent { wire_seq, watermark: applied.event_seq });
                }
                if wire_seq <= self.last_seq {
                    return Err(SyncError::OutOfOrder { wire_seq, last: self.last_seq });
                }
                let mut live = Live {
                    projects: &mut applied.projects,
                    runs: &mut applied.runs,
                    counts: &mut self.counts,
                    bounds: self.bounds,
                    now: &*self.clock,
                };
                let result = live.apply(&channel, &payload);
                self.last_seq = wire_seq;
                self.released.push(ReleasedEvent { wire_seq, scope, channel, payload });
                match result {
                    Ok(effect) => {
                        if effect.state.is_some() || effect.run.is_some() {
                            self.version += 1;
                        }
                        Ok(effect)
                    }
                    Err(error) => {
                        self.closed = Some(error.clone());
                        self.version += 1;
                        Err(error)
                    }
                }
            }
            Notice::Closed(error) => {
                let error = match error {
                    Error::StateTooLarge { hydration } => {
                        SyncError::StateTooLarge { scope: hydration.as_ref().map(|h| h.scope.clone()), method: hydration.map(|h| h.method) }
                    }
                    other => SyncError::Closed(other),
                };
                self.closed = Some(error.clone());
                self.version += 1;
                Err(error)
            }
        }
    }

    /// +1 for every change a view would show.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn counts(&self) -> &Counts {
        &self.counts
    }

    /// The last applied `wire_seq`.
    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// The same reducer reading `clock` for runs' `startedAt` (tests inject one).
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// A reducer with other live-state bounds (tests).
    pub fn with_live_bounds(bounds: LiveBounds) -> Self {
        Self { bounds, ..Self::default() }
    }

    /// The applied snapshot, or the error that closed the stream. Never an empty stand-in.
    pub fn state(&self) -> Result<&Applied, SyncError> {
        if let Some(closed) = &self.closed {
            return Err(closed.clone());
        }
        self.applied.as_ref().ok_or(SyncError::NotApplied)
    }

    pub fn released(&self) -> &Released {
        &self.released
    }

    /// A reducer whose released-event record keeps at most `max_events` events and `max_bytes` payload bytes.
    pub fn with_bounds(max_events: usize, max_bytes: usize) -> Self {
        Self { released: Released::with_bounds(max_events, max_bytes), ..Self::default() }
    }
}

/// A connected adapter whose snapshot is applied and accepted.
pub struct Synced {
    pub adapter: DaemonAdapter,
    pub hello: Hello,
    pub reducer: Reducer,
    /// The snapshot that was applied and then accepted (kept to show the order in tests).
    pub snapshot: RuntimeSnapshot,
    /// Read only after this function returns: events are released by the accept above.
    pub notifications: Notifications,
}

/// Connect, snapshot, apply, accept, in that order. Events stay held by the client until the accept.
pub async fn connect_and_sync(endpoint: FixtureEndpoint) -> anyhow::Result<Synced> {
    let (client, hello, notifications) = Client::connect(endpoint, ClientOptions::default()).await?;
    let snapshot = client.runtime_snapshot().await?;
    let mut reducer = Reducer::default();
    reducer.apply_snapshot(&snapshot)?;
    client.accept_snapshot(&snapshot).await?;
    Ok(Synced { adapter: DaemonAdapter::new(client), hello, reducer, snapshot, notifications })
}

/// The reducer → UI seam: the reducer behind a lock, a version a view compares, and bounded change signals.
///
/// A GPUI view subscribes once and, for each signal, reads what it shows through [`LiveStore::read`]. Signals
/// coalesce (a subscriber's channel holds one), so a slow view skips intermediate versions and never queues them.
#[derive(Clone)]
pub struct LiveStore {
    inner: std::sync::Arc<std::sync::Mutex<StoreInner>>,
}

struct StoreInner {
    reducer: Reducer,
    subscribers: Vec<futures::channel::mpsc::Sender<u64>>,
}

/// At most this many live subscribers at once (closed ones are pruned first).
pub const MAX_SUBSCRIBERS: usize = 64;

impl LiveStore {
    pub fn new(reducer: Reducer) -> Self {
        Self { inner: std::sync::Arc::new(std::sync::Mutex::new(StoreInner { reducer, subscribers: Vec::new() })) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StoreInner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn version(&self) -> u64 {
        self.lock().reducer.version()
    }

    /// Reads the reducer under the lock: keep `read` short and copy out what a view draws.
    pub fn read<R>(&self, read: impl FnOnce(&Reducer) -> R) -> R {
        read(&self.lock().reducer)
    }

    /// A stream of versions; `None` when [`MAX_SUBSCRIBERS`] are already listening.
    pub fn subscribe(&self) -> Option<futures::channel::mpsc::Receiver<u64>> {
        let mut inner = self.lock();
        inner.subscribers.retain(|sender| !sender.is_closed());
        if inner.subscribers.len() >= MAX_SUBSCRIBERS {
            return None;
        }
        let (sender, receiver) = futures::channel::mpsc::channel(0);
        inner.subscribers.push(sender);
        Some(receiver)
    }

    /// Puts `reducer` (a new connection's applied snapshot) in place of the held one and signals every subscriber: a
    /// reconnect replaces the whole state rather than patching the old one.
    pub fn replace(&self, reducer: Reducer) {
        let mut inner = self.lock();
        let version = inner.reducer.version().max(reducer.version()) + 1;
        inner.reducer = Reducer { version, ..reducer };
        inner.subscribers.retain_mut(|sender| match sender.try_send(version) {
            Ok(()) => true,
            Err(error) => error.is_full(),
        });
    }

    /// Applies one notice and signals subscribers when the version moved.
    pub fn apply_notice(&self, notice: Notice) -> Result<Effect, SyncError> {
        let mut inner = self.lock();
        let before = inner.reducer.version();
        let result = inner.reducer.apply_notice(notice);
        let version = inner.reducer.version();
        if version != before {
            // A full channel already holds a signal: the subscriber will read the latest version anyway.
            inner.subscribers.retain_mut(|sender| match sender.try_send(version) {
                Ok(()) => true,
                Err(error) => error.is_full(),
            });
        }
        result
    }

    /// Applies released notices until the stream closes, and returns the error that closed it.
    pub async fn pump(&self, notifications: &mut Notifications) -> SyncError {
        loop {
            let Some(notice) = notifications.next().await else { return SyncError::Closed(Error::Disconnected) };
            match self.apply_notice(notice) {
                Ok(_) | Err(SyncError::StaleEvent { .. } | SyncError::OutOfOrder { .. }) => {}
                Err(error) => return error,
            }
        }
    }
}

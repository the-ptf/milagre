//! The snapshot barrier at the GPUI edge: connect, take `runtime_snapshot()`, apply it to a [`Reducer`], then
//! `accept_snapshot(&snapshot)`, and only then read released events.
//!
//! The reducer holds the applied snapshot decoded into GPUI types and records each released event in order; it does
//! not apply `project:state` patches or `agent:event`s (live streaming is not adopted into the UI in this stage).
//! A closed stream is an error, never an empty state: once `Notice::Closed` arrives, [`Reducer::state`] answers that
//! error (`StateTooLarge` with its required `project:read`, or the client's reason).

use milagre_daemon_client::{Client, ClientOptions, Error, FixtureEndpoint, Hello, Notice, Notifications, RuntimeSnapshot};
use milagre_gpui_spike::data::{ChatRuns, OpenProject};
use std::collections::VecDeque;

use serde_json::Value;

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
    pub fn with_bounds(max_events: usize, max_bytes: usize) -> Self {
        Self { count: 0, tail: VecDeque::new(), bytes: 0, max_events: max_events.max(1), max_bytes }
    }

    fn push(&mut self, event: ReleasedEvent) -> &ReleasedEvent {
        let size = event.payload.to_string().len();
        self.count += 1;
        self.bytes += size;
        self.tail.push_back((event, size));
        while self.tail.len() > self.max_events || (self.bytes > self.max_bytes && self.tail.len() > 1) {
            let (_, dropped) = self.tail.pop_front().expect("non-empty");
            self.bytes -= dropped;
        }
        &self.tail.back().expect("just pushed").0
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

#[derive(Default)]
pub struct Reducer {
    applied: Option<Applied>,
    released: Released,
    closed: Option<SyncError>,
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
        self.released.clear();
        self.closed = None;
        Ok(self.applied.insert(Applied { event_seq, projects, runs, links }))
    }

    /// Takes one notice the client released. An event is recorded; `Closed` latches its error.
    pub fn apply_notice(&mut self, notice: Notice) -> Result<&ReleasedEvent, SyncError> {
        if let Some(closed) = &self.closed {
            return Err(closed.clone());
        }
        match notice {
            Notice::Event { wire_seq, scope, channel, payload } => {
                let Some(applied) = &self.applied else { return Err(SyncError::NotApplied) };
                if wire_seq <= applied.event_seq {
                    return Err(SyncError::StaleEvent { wire_seq, watermark: applied.event_seq });
                }
                Ok(self.released.push(ReleasedEvent { wire_seq, scope, channel, payload }))
            }
            Notice::Closed(error) => {
                let error = match error {
                    Error::StateTooLarge { hydration } => {
                        SyncError::StateTooLarge { scope: hydration.as_ref().map(|h| h.scope.clone()), method: hydration.map(|h| h.method) }
                    }
                    other => SyncError::Closed(other),
                };
                self.closed = Some(error.clone());
                Err(error)
            }
        }
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

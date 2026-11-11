//! The snapshot barrier at the GPUI edge: connect, take `runtime_snapshot()`, apply it to a [`Reducer`], then
//! `accept_snapshot(&snapshot)`, and only then read released events.
//!
//! The reducer holds the applied snapshot decoded into GPUI types and records each released event in order; it does
//! not apply `project:state` patches or `agent:event`s (live streaming is not adopted into the UI in this stage).
//! A closed stream is an error, never an empty state: once `Notice::Closed` arrives, [`Reducer::state`] answers that
//! error (`StateTooLarge` with its required `project:read`, or the client's reason).

use milagre_daemon_client::{Client, ClientOptions, Error, FixtureEndpoint, Hello, Notice, Notifications, RuntimeSnapshot};
use milagre_gpui_spike::data::{ChatRuns, OpenProject};
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

#[derive(Default)]
pub struct Reducer {
    applied: Option<Applied>,
    released: Vec<ReleasedEvent>,
    closed: Option<SyncError>,
}

impl Reducer {
    /// Decodes and holds `snapshot`. Call before `accept_snapshot`; a snapshot that does not decode is not accepted.
    pub fn apply_snapshot(&mut self, snapshot: &RuntimeSnapshot) -> anyhow::Result<&Applied> {
        let body = &snapshot.body;
        if body["eventSeq"].as_u64() != Some(snapshot.event_seq) {
            anyhow::bail!("snapshot eventSeq does not match its watermark {}", snapshot.event_seq);
        }
        let projects = body["projects"].as_array().ok_or_else(|| anyhow::anyhow!("snapshot.projects: expected an array"))?;
        let projects = projects.iter().map(map::open_project).collect::<anyhow::Result<Vec<_>>>()?;
        let runs = &body["runs"];
        let seq = runs["seq"].as_u64().ok_or_else(|| anyhow::anyhow!("snapshot.runs.seq: expected an unsigned integer"))?;
        let runs = map::chat_runs(&milagre_daemon_client::ChatRuns { runs: runs["runs"].clone(), seq })?;
        let links = body["links"].as_array().ok_or_else(|| anyhow::anyhow!("snapshot.links: expected an array"))?.len();
        self.released.clear();
        self.closed = None;
        Ok(self.applied.insert(Applied { event_seq: snapshot.event_seq, projects, runs, links }))
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
                self.released.push(ReleasedEvent { wire_seq, scope, channel, payload });
                Ok(self.released.last().expect("just pushed"))
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

    pub fn released(&self) -> &[ReleasedEvent] {
        &self.released
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

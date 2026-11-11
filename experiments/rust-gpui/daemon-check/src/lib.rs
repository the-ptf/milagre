//! Off-by-default real-data stage of the GPUI port: [`DaemonAdapter`] implements the GPUI crate's `DataSource` on the
//! backend's shared daemon client (`milagre-daemon-client`, frozen at 5eb6d63f), checked headless against the
//! backend's owned `app-fixture`. Nothing in the GPUI app depends on this crate; see `README.md` ("Daemon adapter")
//! in the GPUI crate for how to export the client and run the checks.
//!
//! - [`map`]: the client's raw JSON bodies decoded into GPUI domain types (the GPUI edge).
//! - [`DaemonAdapter`]: the six reads; every other `DataSource` method answers [`NotAvailable`].
//! - [`events`]: connect, snapshot, apply, accept, then released events applied by [`live`]; a closed stream is an
//!   error. [`LiveStore`] is the version-and-read seam a view subscribes to.
//! - [`view`]: the explicit open-on-select seam and the page-to-transcript-items mapping.
#![cfg(unix)]

mod adapter;
pub mod events;
pub mod live;
pub mod map;
pub mod view;

pub use adapter::{DaemonAdapter, NotAvailable};
pub use events::{Applied, LiveStore, Reducer, Released, ReleasedEvent, SyncError, Synced, connect_and_sync};
pub use live::{Counts, Effect, Ignored, LiveBounds};

#[cfg(test)]
mod real;
#[cfg(test)]
mod tests;

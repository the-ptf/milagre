//! Off-by-default real-data stage of the GPUI port: [`DaemonAdapter`] implements the GPUI crate's `DataSource` on the
//! backend's shared daemon client (`milagre-daemon-client`, frozen at a9d85d1d), checked headless against the
//! backend's owned `app-fixture`. Nothing in the GPUI app depends on this crate; see `README.md` ("Daemon adapter")
//! in the GPUI crate for how to export the client and run the checks.
//!
//! - [`map`]: the client's raw JSON bodies decoded into GPUI domain types (the GPUI edge).
//! - [`DaemonAdapter`]: the six reads; every other `DataSource` method answers [`NotAvailable`].
//! - [`events`]: connect, snapshot, apply, accept, then released events; a closed stream is an error.
#![cfg(unix)]

mod adapter;
pub mod events;
pub mod map;

pub use adapter::{DaemonAdapter, NotAvailable};
pub use events::{Applied, Reducer, ReleasedEvent, SyncError, Synced, connect_and_sync};

#[cfg(test)]
mod real;
#[cfg(test)]
mod tests;

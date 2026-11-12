//! The GPUI app on real Chats: the base crate's views, fed through the shared client (`milagre-daemon-client` at
//! 66a7795e, feature `installed-owner`) by the installed Milagre's running Node daemon ([`daemon`], the default) or by
//! the backend's owned dedicated Chat runtime (`--owned`, `--root`). Off by default: the base crate's manifest, lock
//! and app know nothing of this crate. See `README.md` ("Live app") in the GPUI crate.
//!
//! - The adapter's decoding and live reducer are `daemon-check`'s own source files, compiled here against the newer
//!   client (`#[path]`): one source, two client pins. `daemon-check` keeps the app-fixture at 9aa5deb3.
//! - [`session`]: create or open the dedicated root, connect, `project:open`, snapshot, apply, accept, actions.
//! - [`source`]: the app's `DataSource`, read from the live reducer (and `chat:messages` from the client).
//! - [`sinks`]: the composer's `MessageSink` and the sidebar's `SidebarActions`, as [`sinks::Command`]s.
//! - [`sidebar_writes`]: on Milagre's daemon, the sidebar's other writes (Delete, Pin, Filters, Reload, Add Project…).
//! - [`controller`]: the GPUI entity that runs those commands and keeps the transcript, running row, composer queue
//!   and sidebar in step with the reducer.
#![cfg(unix)]

#[path = "../../daemon-check/src/adapter.rs"]
mod adapter;
#[path = "../../daemon-check/src/events.rs"]
pub mod events;
#[path = "../../daemon-check/src/live.rs"]
pub mod live;
#[path = "../../daemon-check/src/map.rs"]
pub mod map;
#[path = "../../daemon-check/src/view.rs"]
pub mod view;

pub mod controller;
pub mod daemon;
pub mod git;
pub mod panels;
pub mod prefs;
pub mod session;
pub mod setup;
pub mod sidebar_writes;
pub mod sinks;
pub mod smoke;
pub mod source;
pub mod terminals;
pub mod transcript;
pub mod usage;

pub use adapter::{DaemonAdapter, NotAvailable};
pub use events::{Applied, LiveStore, Reducer, Released, ReleasedEvent, SyncError, Synced, connect_and_sync};
pub use live::{Counts, Effect, Ignored, LiveBounds};

#[cfg(test)]
mod tests;

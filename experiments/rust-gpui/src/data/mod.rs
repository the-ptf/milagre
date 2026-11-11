//! Domain data: what the UI shows, independent of how it is drawn.
//!
//! - `model.rs`: the domain types (Project, Worktree, Chat, ChatStatus, Message, Provider, usage), after
//!   `packages/shared/src/model.ts`.
//! - `source.rs`: the [`DataSource`] trait, one method per daemon call the UI makes (`project:current`,
//!   `project:open`, `state:read`, `project:read`, `chat:runs`, `chat:messages`), async and `Send`.
//! - `fixture.rs`: [`FixtureSource`], deterministic data behind that trait. Nothing here connects to a real
//!   daemon yet.
//!
//! Views turn domain types into their own view models (the sidebar's `ChatRow`), so this module never
//! depends on `workspace/`.

pub mod fixture;
mod model;
mod source;

#[cfg(test)]
mod tests;

pub use fixture::FixtureSource;
pub use model::*;
pub use source::{Data, DataFuture, DataSource, ready};

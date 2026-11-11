//! Disposable quota adapter, disabled by default. No production adoption or transport.
#[cfg(all(feature = "fixture-adapter", unix))]
mod adapter;
#[cfg(all(feature = "fixture-adapter", unix))]
mod pinned;
#[cfg(all(feature = "fixture-adapter", unix))]
pub use adapter::*;

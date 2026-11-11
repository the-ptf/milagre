//! One native core, one exclusive copied-service actor, one fixed synthetic turn.
#![cfg(target_os = "macos")]
mod composed_owner;
#[cfg(test)]
mod composed_tests;
#[allow(dead_code)] // The same core also supplies the feature wrapper and standalone wait façade.
#[path = "../../src/private_copy/core.rs"]
mod native_core;
#[allow(dead_code)] // Shared private source also implements the admission-only fixture façade.
mod service_owner;

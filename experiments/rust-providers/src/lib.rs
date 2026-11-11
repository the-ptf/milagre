//! Provider process adapters for Milagre's Rust backend.
//!
//! Today: the Codex app-server transport ([`codex::rpc`]), its typed client ([`codex::client`]),
//! approval/question translation ([`codex::approvals`]) and the thread/turn lifecycle
//! ([`codex::session`]). See README.md for what is and isn't ported from packages/core.

// Errors carry the exit detail and both resume attempts by value; they are rare and not hot.
#![allow(clippy::result_large_err)]

pub mod codex;

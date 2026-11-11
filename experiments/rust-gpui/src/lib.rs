//! Milagre's desktop UI in GPUI (Zed's Rust UI framework), growing from a spike into a full port that runs
//! beside the Tauri shell. `main.rs` only calls [`app::run`]; everything else lives in this library so the
//! headless tests can mount it. Module layout and the rules for parallel work: `CONVENTIONS.md`.

pub mod app;
pub mod assets;
pub mod data;
#[cfg(target_os = "macos")]
pub mod snapshot;
pub mod theme;
pub mod ui;
pub mod workspace;

#[cfg(test)]
pub mod testing;

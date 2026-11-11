//! Milagre's desktop UI in GPUI (Zed's Rust UI framework), growing from a spike into a full port that runs
//! beside the Tauri shell. `main.rs` only calls [`app::run`]; everything else lives in this library so the
//! headless tests can mount it. Module layout and the rules for parallel work: `CONVENTIONS.md`.

pub mod app;
pub mod assets;
pub mod data;
pub mod diagram;
// WP-01's gpui-component fit check: probe views and tests, never in the app (COMPONENT-FIT.md).
#[cfg(any(test, feature = "fitcheck"))]
pub mod fitcheck;
pub mod genui;
pub mod logic;
pub mod notices;
pub mod onboarding;
pub mod overlays;
pub mod platform;
pub mod routines;
pub mod settings;
#[cfg(target_os = "macos")]
pub mod snapshot;
pub mod theme;
pub mod ui;
pub mod workspace;

#[cfg(test)]
pub mod testing;

//! GPUI spike for Milagre's desktop UI: the three-column shell (sidebar, Chat, side panel) drawn
//! with Zed's GPUI and Milagre's theme tokens. `main.rs` opens the window; every view lives here so
//! tests can mount it in a GPUI test window.

pub mod chat;
pub mod chrome;
pub mod panel;
pub mod sidebar;
#[cfg(target_os = "macos")]
pub mod snapshot;
pub mod theme;
pub mod workspace;

#[cfg(test)]
mod tests;

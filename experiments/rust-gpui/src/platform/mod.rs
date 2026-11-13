//! Native platform pieces GPUI does not have: a web page in a child view (`webview.rs`, macOS), and a paste's file
//! URLs (`pasteboard.rs`).

// The Browser panel spike's own Chromium (BROWSER-EXPLORATION.md); production browsers are the daemon's.
pub mod cdp;
pub mod pasteboard;
pub mod updates;
pub mod webview;

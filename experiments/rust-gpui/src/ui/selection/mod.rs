//! Text selection helpers shared by views that copy what a reader selected (WP-16).
//!
//! The desktop has no copy handler of its own: ⌘C in the transcript is Chromium serialising the DOM selection as
//! `text/plain` (its `TextIterator`). [`plain`] reproduces that serialisation from the Markdown source, so a copy
//! does not depend on which messages are laid out, and gives the same text the Electron app puts on the clipboard.

pub mod plain;

#[cfg(test)]
mod tests;

pub use plain::{Flavor, Plain, join, plain_text};

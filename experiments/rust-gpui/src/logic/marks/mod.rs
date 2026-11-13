//! What a Chat is doing and how a row says so: the mark ([`chat_mark`]), its glyph, tone and words
//! ([`chat_mark_presentation`]), the activity behind it ([`activity`]) and the live time formats
//! ([`display_clock`]). Pure ports of the shared TypeScript; no UI.

pub mod activity;
pub mod chat_mark;
pub mod display_clock;
pub mod tone;

pub use chat_mark::{ChatMark, MarkIcon, MarkInput, MarkPresentation, chat_mark, chat_mark_presentation, chat_mark_tone};
pub use tone::Tone;

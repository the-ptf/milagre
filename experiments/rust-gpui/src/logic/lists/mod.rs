//! How Chats and Projects are ordered, grouped, listed and pinned for the sidebar, and the small preferences and
//! histories around them. Pure ports of the shared TypeScript (`packages/shared/src`, with `chat-list.ts` from the
//! desktop app); no UI, no I/O. `logic::marks` has the row marks and `logic::identity` the Project and provider
//! identity rules.

pub mod chat_display;
pub mod chat_row;
pub mod chats;
pub mod done;
pub mod jsstr;
pub mod order;
pub mod pins;
pub mod raw;
pub mod stable_order;
pub mod subchats;
pub mod undo_history;

pub use raw::Raw;

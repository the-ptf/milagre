//! Usage and limit logic after `packages/shared/src/usage.ts`, `usage-limit.mjs`, `tokens.mjs` and
//! `new-chat-glance.ts`: tones, percent and reset labels, snapshot merging, the limit card's text, token counts
//! and the New Chat glance. Pure functions; time comes in as a millisecond clock and a [`time::Zone`].

pub mod glance;
pub mod limit;
pub mod report;
pub mod time;
pub mod tokens;

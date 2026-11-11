//! Logic behind the transcript, composer and attention chips after `packages/shared/src/subchat-states.ts`,
//! `subagent-glance.mjs`, `queued-messages.mjs`, `send-retry.mjs` and `attention.mjs`. Pure functions.

pub mod attention;
pub mod queued;
pub mod send_retry;
pub mod subagent_glance;
pub mod subchat_states;

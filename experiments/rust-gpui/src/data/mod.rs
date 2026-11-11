//! Domain data: what the UI shows, independent of how it is drawn, in the shapes the daemon sends.
//!
//! | File          | Types                                                                            | TypeScript source                                                                             |
//! | ------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
//! | `provider.rs` | `Provider` (picker order: Codex, Claude, Antigravity, Kiro)                      | `ModelProvider` in `packages/shared/src/model.ts`; order and names in `shared/src/providers.mjs` |
//! | `project.rs`  | `Computer`, `ComputersSnapshot`, `ScopeKey`, `Project`, `ProjectKind`,           | `ComputerView`, `ComputersSnapshot`, `StateStamp`, `ProjectRead` in `apps/desktop/app/src/electron.d.ts`; |
//! |               | `OpenProject`, `StateStamp`, `StateRead`, `ScopeState`, `Worktree`, `DiffStat`   | `RecentProject` in `apps/desktop/app/src/lib/project-list.ts`; `OpenProject`, `CoordinatorState`, `Worktree` in `model.ts` |
//! | `chat.rs`     | `Chat`, `ChatSummary`, `Subagent`, `BackgroundTask`, `RoutineRef`, `Outcome`, ... | `AgentSession`, `ChatSummary`, `Subagent`, `BackgroundTask`, `QueuedMessage` in `model.ts`     |
//! | `runs.rs`     | `ChatRuns`, `AgentRun`, `PermissionRequest`, `QuestionRequest`                   | `AgentRun` in `packages/shared/src/agent-runs.d.mts`; `PermissionRequest`, `QuestionRequest` in `model.ts` |
//! | `message.rs`  | `ChatMessage`, `ChatContext`, `ChatStep`, `PageRequest`, `MessagePage`, ...      | `ChatMessage`, `ChatContext`, `ChatStep` in `model.ts`; `MessageChanges` in `electron.d.ts`    |
//! | `pr.rs`       | `PullRequest` (= `logic::prs`'s), `PullRequestSnapshot`                          | `PullRequest`, `PullRequestSnapshot` in `model.ts`                                             |
//! | `usage.rs`    | `UsageSnapshot`, `ProviderUsage` (around `logic::usage`'s `AccountUsage`)        | `UsageSnapshot`, `ProviderUsage`, `UsageWindow` in `model.ts`                                  |
//! | `edge.rs`     | Conversions into the `src/logic` rules' input structs                            |                                                                                               |
//! | `source.rs`   | The read-only [`DataSource`] trait, one method per daemon method                 | the daemon methods named on each method                                                       |
//! | `fixture.rs`  | [`FixtureSource`]: three computers, their Projects and Chats, behind the trait   |                                                                                               |
//!
//! Where a `src/logic` module already had the full TypeScript shape, this module re-exports it instead of copying it
//! (`PullRequest`, `AgentQuestion`, `QuestionOption`, `StepKind`, `ContextUsage`, the usage windows and accounts,
//! the subagent transcript entries and progress). Where a rule reads only a few fields, its input struct stays in
//! `src/logic` and `edge.rs` builds it from the domain type, which is the one place the field lives.
//!
//! Plain data: no GPUI views, no I/O, no serde. Decoding the daemon's JSON into these types is the adapter's
//! (`experiments/rust-daemon-client`); `serde_json::Value` appears only where a message context kind is kept whole.
//! Views turn domain types into their own view models (the sidebar's `ChatRow`), so this module never depends on
//! `workspace/` or `ui/`.

mod chat;
mod edge;
pub mod fixture;
mod message;
mod pr;
mod project;
mod provider;
mod runs;
mod source;
mod usage;

#[cfg(test)]
mod tests;

pub use chat::*;
pub use fixture::FixtureSource;
pub use message::*;
pub use pr::*;
pub use project::*;
pub use provider::Provider;
pub use runs::*;
pub use source::{Data, DataFuture, DataSource, Polled, now, poll_once, ready};
pub use usage::*;

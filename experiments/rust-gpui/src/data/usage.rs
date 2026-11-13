//! Plan usage: what `usage:cached` / `usage:read` answer. Sources: `UsageSnapshot`, `ProviderUsage`, `UsageWindow`,
//! `ProviderAccount` in `packages/shared/src/model.ts`.
//!
//! The window and account types are `logic::usage::report`'s (`WindowUsage`, `AccountRef`, `AccountUsage`), so the
//! usage rules (tones, labels, merging) run on them directly. `AccountUsage` lacks two fields of `ProviderUsage`
//! (`checkedAt`, `message`); [`ProviderUsage`] carries them beside it, and [`UsageSnapshot::report`] gives the
//! logic's own snapshot for `merge_snapshot` and the rest.

use gpui::SharedString;

use crate::logic::usage::report::UsageSnapshot as ReportSnapshot;
pub use crate::logic::usage::report::{AccountRef, AccountUsage, WindowUsage};

/// `ProviderUsage.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageStatus {
    Ok,
    Unavailable,
    /// The last read failed; the windows are the last known ones.
    Error,
}

/// `ProviderUsage`: one provider's limits for one Account.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderUsage {
    /// Account, provider, status, windows (`label`, `shortLabel`, `usedPercent`, `resetsAt`, `detail`),
    /// `updatedAt` and `bankedResets`.
    pub usage: AccountUsage,
    /// The latest finished check, including unsuccessful ones (quota times stay in `updated_at`).
    pub checked_at: Option<SharedString>,
    /// Why the read failed or the provider has no numbers, in words.
    pub message: Option<SharedString>,
}

impl std::ops::Deref for ProviderUsage {
    type Target = AccountUsage;

    fn deref(&self) -> &AccountUsage {
        &self.usage
    }
}

/// `UsageSnapshot`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageSnapshot {
    pub account_key: Option<SharedString>,
    /// Host clock at the read, ISO.
    pub generated_at: Option<SharedString>,
    pub providers: Vec<ProviderUsage>,
}

impl UsageSnapshot {
    /// The snapshot as `logic::usage::report` reads it.
    pub fn report(&self) -> ReportSnapshot {
        ReportSnapshot {
            account_key: self.account_key.as_ref().map(ToString::to_string),
            generated_at: self.generated_at.as_ref().map(ToString::to_string),
            providers: self.providers.iter().map(|provider| provider.usage.clone()).collect(),
        }
    }
}

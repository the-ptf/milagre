//! Plan usage: what `usage:accounts:read` answers and how `AccountUsageSection.tsx` groups it (every account
//! stays separate, grouped by provider in picker order), built on `logic::usage::report`.

use gpui::SharedString;

use super::model::AccountState;
use crate::data::{AccountUsage, Provider, UsageStatus};
use crate::logic::usage::report::{UsageSnapshot, account_usage_groups};

/// One account's usage and who it belongs to.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanAccount {
    pub usage: AccountUsage,
    pub state: AccountState,
    /// `ProviderUsage.message`.
    pub message: Option<SharedString>,
}

impl PlanAccount {
    pub fn id(&self) -> &str {
        self.usage.account.as_ref().map_or("", |account| account.id.as_str())
    }

    /// `identity.label`.
    pub fn label(&self) -> &str {
        self.usage.account.as_ref().map_or("", |account| account.label.as_str())
    }

    pub fn email(&self) -> Option<&str> {
        self.usage.account.as_ref().and_then(|account| account.email.as_deref()).filter(|email| !email.is_empty())
    }

    /// The last read failed but numbers from an earlier one are still shown (`stale`).
    pub fn stale(&self) -> bool {
        self.usage.status == UsageStatus::Error && !self.usage.windows.is_empty()
    }
}

/// `UsageSnapshot` with the identity details the cards need.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlanSnapshot {
    pub accounts: Vec<PlanAccount>,
    pub error: Option<SharedString>,
}

/// One provider's card.
pub struct PlanGroup<'a> {
    pub provider: Provider,
    pub accounts: Vec<&'a PlanAccount>,
}

impl PlanSnapshot {
    /// The snapshot as `logic::usage::report` reads it.
    pub fn report(&self) -> UsageSnapshot {
        UsageSnapshot {
            account_key: Some("accounts".to_string()),
            generated_at: None,
            providers: self.accounts.iter().map(|entry| entry.usage.clone()).collect(),
        }
    }

    /// `accountUsageGroups`: providers with at least one account, in picker order.
    pub fn groups(&self) -> Vec<PlanGroup<'_>> {
        let report = self.report();
        account_usage_groups(Some(&report))
            .into_iter()
            .map(|(provider, usages)| PlanGroup {
                provider,
                accounts: usages
                    .iter()
                    .filter_map(|usage| {
                        self.accounts.iter().find(|entry| entry.usage.provider == provider && entry.usage.account == usage.account)
                    })
                    .collect(),
            })
            .collect()
    }

    /// `overviewUpdatedAt`: the oldest last-good read.
    pub fn updated_at(&self) -> Option<String> {
        crate::logic::usage::report::overview_updated_at(Some(&self.report()))
    }
}

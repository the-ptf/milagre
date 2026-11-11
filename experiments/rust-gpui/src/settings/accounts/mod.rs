//! Accounts and Usage sections of Settings (WP-42: `AccountsSettings.tsx`, `ProjectAccountsSettings.tsx`, the
//! limit switches in `Settings.tsx`, `TokenUsagePage.tsx`, `AccountUsageSection.tsx`; G-11 and G-12).
//!
//! - `model.rs`: the accounts as `accounts:list` answers them and the actions on them ([`AccountsStore`], a
//!   global), the Antigravity install row, each Project's choice.
//! - `plan.rs`, `token_usage.rs`: plan usage grouped by provider; the token usage report, formats and calendar.
//! - `fixture.rs`: deterministic data for both pages. Nothing here talks to the daemon yet.
//! - `page.rs`: the Accounts page ([`AccountsView`]); `usage.rs`: the Usage page ([`UsageView`]) with Plan
//!   usage and Analytics (`plan_cards.rs`, `analytics.rs`); `style.rs`: the usage meter and the card ring.
//!
//! Not built: the plan-icon marks inside the Per Project selects (`Select` options have no icon slot) and the
//! default account's "Default" chip in the select trigger; the Usage page lives in the Settings column (the React
//! page fills the whole panel), so its columns wrap earlier.

pub mod analytics;
pub mod fixture;
pub mod model;
pub mod page;
pub mod plan;
pub mod plan_cards;
pub mod style;
pub mod token_usage;
pub mod usage;

#[cfg(test)]
mod tests;

use gpui::{AnyElement, App, Entity, IntoElement};

pub use model::AccountsStore;
pub use page::AccountsView;
pub use usage::UsageView;

use super::{SelectedSection, SettingsSectionId};

/// Installs the global [`AccountsStore`] (the fixture accounts) if it is not there yet. Called from
/// [`super::init`].
pub fn init(cx: &mut App) {
    if !cx.has_global::<AccountsStore>() {
        let projects = fixture_projects(cx);
        cx.set_global(fixture::accounts_store(&projects));
    }
}

/// The Projects the data source lists on this computer, as `(path, name)`.
pub fn fixture_projects(cx: &App) -> Vec<(String, String)> {
    use crate::data::{Data, LOCAL, Polled, poll_once};
    let Some(source) = cx.try_global::<Data>().map(|data| data.0.clone()) else { return Vec::new() };
    match poll_once(source.recent_projects(LOCAL.into())) {
        Polled::Ready(Ok(list)) => {
            list.into_iter().filter(|p| !p.hidden && !p.is_chats_home()).map(|p| (p.path.to_string(), p.name.to_string())).collect()
        }
        _ => Vec::new(),
    }
}

/// The body of the Accounts or Usage section, or `None` for any other section. Also tells the page which row a
/// search result lit up.
pub fn section_body(
    selected: &SelectedSection,
    highlighted: Option<&str>,
    accounts: &Entity<AccountsView>,
    usage: &Entity<UsageView>,
    cx: &mut App,
) -> Option<AnyElement> {
    match selected {
        SelectedSection::Section(SettingsSectionId::Accounts) => {
            accounts.update(cx, |view, cx| view.set_found(highlighted, cx));
            Some(accounts.clone().into_any_element())
        }
        SelectedSection::Section(SettingsSectionId::Usage) => {
            usage.update(cx, |view, cx| view.set_found(highlighted, cx));
            Some(usage.clone().into_any_element())
        }
        _ => None,
    }
}

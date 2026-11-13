//! Provider order and names (`packages/shared/src/providers.mjs`): the picker order and the names used by every
//! client and CLI notice. Providers are named by their id string here (`"claude"`); [`provider_id`] and
//! [`provider_from_id`] connect them to the domain's `Provider`.

use std::collections::HashMap;

use crate::data::Provider;

/// Picker order. (`Provider::ALL` in `data` lists Claude first; the picker lists Codex first.)
pub const PROVIDERS: [&str; 4] = ["codex", "claude", "antigravity", "kiro"];

/// The id string of a domain provider.
pub fn provider_id(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
        Provider::Antigravity => "antigravity",
        Provider::Kiro => "kiro",
    }
}

/// The domain provider an id string names.
pub fn provider_from_id(id: &str) -> Option<Provider> {
    Provider::ALL.into_iter().find(|provider| provider_id(*provider) == id)
}

/// `(name, cli)` for a provider; an unknown one reads as Claude.
fn names(provider: Option<&str>) -> (&'static str, &'static str) {
    match provider {
        Some("codex") => ("Codex", "Codex"),
        Some("antigravity") => ("Antigravity", "Antigravity"),
        Some("kiro") => ("Kiro", "Kiro CLI"),
        _ => ("Claude", "Claude Code"),
    }
}

/// The provider's name ("Claude"); an unknown provider reads as Claude.
pub fn provider_name(provider: Option<&str>) -> &'static str {
    names(provider).0
}

/// The provider's CLI name ("Claude Code", "Kiro CLI"); an unknown provider reads as Claude.
pub fn cli_name(provider: Option<&str>) -> &'static str {
    names(provider).1
}

/// The provider tabs the model picker shows: every provider whose CLI is installed, plus the ones in `keep` (the
/// Chat's own and the open tab) so a Chat on a missing one still has its tab and notice. An agent installed later
/// (Accounts settings or by hand) appears once the status is checked again. Until it is known (`status` is
/// `None`), every provider shows. `status` maps a provider id to its CLI state (`"ready"`, `"outdated"`,
/// `"missing"`, ...); a provider without an entry counts as not missing.
pub fn picker_providers(status: Option<&HashMap<&str, &str>>, keep: &[&str]) -> Vec<&'static str> {
    PROVIDERS
        .into_iter()
        .filter(|provider| keep.contains(provider) || status.and_then(|status| status.get(provider)) != Some(&"missing"))
        .collect()
}

/// The category of an account's plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountType {
    Business,
    Team,
    Personal,
}

impl AccountType {
    pub fn label(self) -> &'static str {
        match self {
            AccountType::Business => "Business",
            AccountType::Team => "Team",
            AccountType::Personal => "Personal",
        }
    }
}

/// Public account categories shared by desktop and mobile. Unknown plans get no badge.
pub fn account_type(plan: Option<&str>) -> Option<AccountType> {
    let value = crate::logic::lists::jsstr::js_trim(plan.unwrap_or("")).to_lowercase();
    match value.as_str() {
        "business" | "enterprise" | "self_serve_business" | "self_serve_business_polite" => Some(AccountType::Business),
        "team" => Some(AccountType::Team),
        "free" | "plus" | "pro" | "max" | "go" | "personal" => Some(AccountType::Personal),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(entries: &[(&'static str, &'static str)]) -> HashMap<&'static str, &'static str> {
        entries.iter().copied().collect()
    }

    const MISSING_TWO: [(&str, &str); 4] = [("codex", "ready"), ("claude", "ready"), ("antigravity", "missing"), ("kiro", "missing")];

    #[test]
    fn the_picker_hides_providers_whose_cli_is_not_installed() {
        assert_eq!(picker_providers(Some(&status(&MISSING_TWO)), &["claude"]), ["codex", "claude"]);
    }

    #[test]
    fn the_picker_keeps_the_current_provider_and_other_unready_ones() {
        let outdated = status(&[("codex", "outdated"), ("claude", "ready"), ("antigravity", "missing"), ("kiro", "missing")]);
        assert_eq!(picker_providers(Some(&outdated), &["antigravity"]), ["codex", "claude", "antigravity"]);
    }

    #[test]
    fn the_picker_keeps_the_open_tab_when_its_cli_goes_missing() {
        assert_eq!(picker_providers(Some(&status(&MISSING_TWO)), &["codex", "antigravity"]), ["codex", "claude", "antigravity"]);
    }

    #[test]
    fn the_picker_shows_every_provider_until_the_status_is_known() {
        assert_eq!(picker_providers(None, &["claude"]), ["codex", "claude", "antigravity", "kiro"]);
        // A provider the status doesn't mention is not missing.
        assert_eq!(picker_providers(Some(&status(&[("kiro", "missing")])), &[]), ["codex", "claude", "antigravity"]);
    }

    #[test]
    fn names_and_cli_names_with_claude_for_the_unknown() {
        assert_eq!(PROVIDERS.map(|provider| provider_name(Some(provider))), ["Codex", "Claude", "Antigravity", "Kiro"]);
        assert_eq!(PROVIDERS.map(|provider| cli_name(Some(provider))), ["Codex", "Claude Code", "Antigravity", "Kiro CLI"]);
        assert_eq!(provider_name(Some("gemini")), "Claude");
        assert_eq!(cli_name(None), "Claude Code");
    }

    #[test]
    fn the_domain_providers_name_and_order_match_the_shared_ones() {
        for provider in Provider::ALL {
            assert_eq!(provider_name(Some(provider_id(provider))), provider.name());
            assert_eq!(provider_from_id(provider_id(provider)), Some(provider));
            assert!(PROVIDERS.contains(&provider_id(provider)));
        }
        assert_eq!(provider_from_id("gemini"), None);
    }

    #[test]
    fn account_types_group_the_plans_and_leave_unknown_ones_without_a_badge() {
        for plan in ["business", "Enterprise", " self_serve_business ", "self_serve_business_polite"] {
            assert_eq!(account_type(Some(plan)), Some(AccountType::Business), "{plan}");
        }
        assert_eq!(account_type(Some("TEAM")), Some(AccountType::Team));
        for plan in ["free", "plus", "pro", "max", "go", "personal"] {
            assert_eq!(account_type(Some(plan)), Some(AccountType::Personal), "{plan}");
        }
        assert_eq!(account_type(Some("gold")), None);
        assert_eq!(account_type(Some("")), None);
        assert_eq!(account_type(None), None);
        assert_eq!(AccountType::Team.label(), "Team");
    }
}

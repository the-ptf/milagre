//! After `packages/shared/src/usage-limit.mjs`: the limit card under a reply the plan's usage limit stopped, what
//! it says, and which accounts it offers. Times show in the viewer's zone ([`Zone`]); see [`super::time`] for the
//! locale the formats reproduce.
//!
//! Not ported: `usageLimitOf`, `isAccountSwitch` and `isLimitReset` only inspect a message's JSON `context`; the
//! Rust message type has no such field yet, so the decoder that adds it should test `context.kind` against
//! `"limit"`, `"account-switch"` and `"limit-reset"`.

use super::time::{self, Zone};
use crate::data::Provider;

/// `accountType` from `providers.mjs`: Settings › Accounts' badge for a plan; unknown plans get none.
pub fn account_type(plan: Option<&str>) -> Option<&'static str> {
    let plan = crate::logic::copy::js::trim(plan?).to_lowercase();
    match plan.as_str() {
        "business" | "enterprise" | "self_serve_business" | "self_serve_business_polite" => Some("Business"),
        "team" => Some("Team"),
        "free" | "plus" | "pro" | "max" | "go" | "personal" => Some("Personal"),
        _ => None,
    }
}

/// `resetTime`: "4:10 PM" today, "Thu 4:10 PM" later, in the viewer's zone; `None` when the time is unknown or past.
pub fn reset_time(iso: Option<&str>, now: i64, zone: &dyn Zone) -> Option<String> {
    let at = time::parse_iso_ms(iso.filter(|text| !text.is_empty())?)?;
    if at <= now {
        return None;
    }
    let local = time::local_time(at, zone);
    let clock = local.time_12h();
    Some(if local.same_day(&time::local_time(now, zone)) { clock } else { format!("{} {clock}", local.weekday_short()) })
}

/// `UsageLimitContext`, trimmed to what the card reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageLimit {
    pub provider: Provider,
    pub account_id: Option<String>,
    pub resets_at: Option<String>,
}

/// The card's heading and the line under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitHeadline {
    pub title: String,
    pub detail: String,
}

/// `limitHeadline`.
pub fn limit_headline(limit: &UsageLimit, now: i64, zone: &dyn Zone) -> LimitHeadline {
    let detail = match reset_time(limit.resets_at.as_deref(), now, zone) {
        Some(reset) => format!("It resets at {reset}."),
        None => "It resets later.".to_string(),
    };
    LimitHeadline { title: format!("{} hit its usage limit", limit.provider.name()), detail }
}

/// `ProviderAccount.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountState {
    Unknown,
    Ready,
    SignedOut,
    SigningIn,
    Error,
}

/// A provider Account as `accounts:scope` lists it (`ProviderAccount`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAccount {
    pub id: String,
    pub label: String,
    pub state: AccountState,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub limited_until: Option<String>,
    /// An explicit assignment whose saved profile was removed.
    pub missing: bool,
}

/// One provider's Accounts for a Project (`ProjectAccountsSnapshot.providers[i]`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAccounts {
    pub provider: Provider,
    pub effective_id: String,
    pub accounts: Vec<ProviderAccount>,
}

/// What `limitChoices` returns for one account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitChoice {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub disabled: bool,
}

/// `limitChoices`: the Project's other Accounts for the limit's provider, each with why it can't be picked (not
/// signed in, or limited too); otherwise the detail is the account type. An unknown type reads as an empty detail
/// (the TypeScript returns `null` there).
pub fn limit_choices(groups: &[ProviderAccounts], limit: &UsageLimit, now: i64, zone: &dyn Zone) -> Vec<LimitChoice> {
    let Some(group) = groups.iter().find(|group| group.provider == limit.provider) else { return Vec::new() };
    group
        .accounts
        .iter()
        .filter(|account| account.id != group.effective_id && !account.missing)
        .map(|account| {
            let limited_until = account.limited_until.as_deref().filter(|text| !text.is_empty()).and_then(|text| reset_time(Some(text), now, zone));
            let unavailable = if account.state != AccountState::Ready {
                Some("Not signed in".to_string())
            } else {
                limited_until.map(|time| format!("Limited until {time}"))
            };
            let label = match &account.email {
                Some(email) if !email.is_empty() => email.clone(),
                _ => account.label.clone(),
            };
            LimitChoice {
                id: account.id.clone(),
                label,
                disabled: unavailable.is_some(),
                detail: unavailable.unwrap_or_else(|| account_type(account.plan.as_deref()).unwrap_or_default().to_string()),
            }
        })
        .collect()
}

/// `switchedText`: what the card says once a switch went through.
pub fn switched_text(continued: bool, label: &str) -> String {
    if continued { format!("Switched to {label}. Continuing\u{2026}") } else { format!("Switched to {label}. Send your message again to continue.") }
}

/// `accountSwitchText`: the line a Chat shows where it continued on another account after the limit.
pub fn account_switch_text(label: &str) -> String {
    format!("Switched to {label} after the usage limit")
}

/// `limitResetText`: a continuation on the same Account after its plan's usage limit reset.
pub fn limit_reset_text() -> &'static str {
    "Continued after the usage limit reset"
}

/// `limitResumeLabel`. `pending_at` is the pending schedule's time; schedules stay visible for a short allowance
/// after the reported reset time ("Continues shortly").
pub fn limit_resume_label(pending_at: Option<&str>, limit: &UsageLimit, now: i64, zone: &dyn Zone) -> Option<String> {
    if let Some(at) = pending_at {
        return Some(match reset_time(Some(at), now, zone) {
            Some(time) => format!("Continues at {time}"),
            None => "Continues shortly".to_string(),
        });
    }
    reset_time(limit.resets_at.as_deref(), now, zone).map(|time| format!("Continue at {time}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::usage::time::{FixedZone, epoch_ms, format_iso};

    /// The TypeScript test's `new Date(2026, 9, 13, h, m)` in a zone, as an ISO string.
    fn at(day: i64, hour: i64, minute: i64, offset: i32) -> String {
        format_iso(epoch_ms(2026, 10, day, hour, minute, offset))
    }

    fn limit(offset: i32) -> UsageLimit {
        UsageLimit { provider: Provider::Claude, account_id: Some("default".into()), resets_at: Some(at(13, 16, 10, offset)) }
    }

    fn account(id: &str, label: &str, state: AccountState) -> ProviderAccount {
        ProviderAccount { id: id.into(), label: label.into(), state, email: None, plan: None, limited_until: None, missing: false }
    }

    fn snapshot(offset: i32) -> Vec<ProviderAccounts> {
        vec![
            ProviderAccounts {
                provider: Provider::Claude,
                effective_id: "default".into(),
                accounts: vec![
                    account("default", "Default", AccountState::Ready),
                    ProviderAccount { email: Some("me@work.com".into()), plan: Some("Max".into()), ..account("work", "Work", AccountState::Ready) },
                    ProviderAccount { limited_until: Some(at(13, 14, 0, offset)), ..account("side", "Side", AccountState::Ready) },
                    account("old", "Old", AccountState::SignedOut),
                    ProviderAccount { missing: true, ..account("gone", "Removed account", AccountState::Error) },
                ],
            },
            ProviderAccounts { provider: Provider::Codex, effective_id: "default".into(), accounts: vec![account("c", "C", AccountState::Ready)] },
        ]
    }

    // The test runs in three zones, as the TypeScript runs in whatever zone the machine has.
    const ZONES: [i32; 3] = [0, 9 * 60, -8 * 60];

    #[test]
    fn the_reset_reads_as_a_time_today_a_weekday_and_time_later_and_nothing_once_past() {
        for offset in ZONES {
            let zone = FixedZone(offset);
            let now = epoch_ms(2026, 10, 13, 12, 0, offset);
            assert_eq!(reset_time(limit(offset).resets_at.as_deref(), now, &zone).as_deref(), Some("4:10 PM"));
            assert_eq!(reset_time(Some(&at(15, 9, 0, offset)), now, &zone).as_deref(), Some("Thu 9:00 AM"));
            assert_eq!(reset_time(Some(&at(13, 11, 0, offset)), now, &zone), None);
            assert_eq!(reset_time(Some(&at(13, 12, 0, offset)), now, &zone), None);
            assert_eq!(reset_time(None, now, &zone), None);
            assert_eq!(reset_time(Some("nope"), now, &zone), None);
            assert_eq!(
                limit_headline(&limit(offset), now, &zone),
                LimitHeadline { title: "Claude hit its usage limit".into(), detail: "It resets at 4:10 PM.".into() }
            );
            let no_reset = UsageLimit { provider: Provider::Codex, account_id: None, resets_at: None };
            assert_eq!(limit_headline(&no_reset, now, &zone).detail, "It resets later.");
            assert_eq!(limit_headline(&no_reset, now, &zone).title, "Codex hit its usage limit");
        }
    }

    #[test]
    fn midnight_in_the_viewers_zone_decides_what_today_means() {
        // 23:30 UTC on the 13th is already the 14th in Tokyo: a reset at 00:30 UTC on the 14th is "today" there.
        let now = epoch_ms(2026, 10, 13, 23, 30, 0);
        let reset = at(14, 0, 30, 0);
        assert_eq!(reset_time(Some(&reset), now, &FixedZone(0)).as_deref(), Some("Wed 12:30 AM"));
        assert_eq!(reset_time(Some(&reset), now, &FixedZone(9 * 60)).as_deref(), Some("9:30 AM"));
    }

    #[test]
    fn the_card_offers_the_providers_other_accounts_and_says_why_one_cant_be_picked() {
        for offset in ZONES {
            let zone = FixedZone(offset);
            let now = epoch_ms(2026, 10, 13, 12, 0, offset);
            let choices = limit_choices(&snapshot(offset), &limit(offset), now, &zone);
            let shape: Vec<(&str, &str, &str, bool)> = choices.iter().map(|c| (c.id.as_str(), c.label.as_str(), c.detail.as_str(), c.disabled)).collect();
            assert_eq!(
                shape,
                vec![("work", "me@work.com", "Personal", false), ("side", "Side", "Limited until 2:00 PM", true), ("old", "Old", "Not signed in", true)]
            );
            assert!(limit_choices(&[], &limit(offset), now, &zone).is_empty());
        }
    }

    #[test]
    fn a_limit_that_already_passed_no_longer_disables_an_account() {
        let zone = FixedZone(0);
        let now = epoch_ms(2026, 10, 13, 15, 0, 0);
        let choices = limit_choices(&snapshot(0), &limit(0), now, &zone);
        let side = choices.iter().find(|c| c.id == "side").unwrap();
        assert_eq!((side.detail.as_str(), side.disabled), ("", false));
    }

    #[test]
    fn plans_map_to_account_types() {
        assert_eq!(account_type(Some("Max")), Some("Personal"));
        assert_eq!(account_type(Some(" Enterprise ")), Some("Business"));
        assert_eq!(account_type(Some("team")), Some("Team"));
        assert_eq!(account_type(Some("self_serve_business_polite")), Some("Business"));
        assert_eq!(account_type(Some("weird")), None);
        assert_eq!(account_type(None), None);
    }

    #[test]
    fn after_a_switch_the_card_says_whether_the_chat_continues_by_itself() {
        assert_eq!(switched_text(true, "me@work.com"), "Switched to me@work.com. Continuing…");
        assert_eq!(switched_text(false, "me@work.com"), "Switched to me@work.com. Send your message again to continue.");
        assert_eq!(account_switch_text("me@work.com"), "Switched to me@work.com after the usage limit");
        assert_eq!(limit_reset_text(), "Continued after the usage limit reset");
    }

    #[test]
    fn the_resume_label_follows_the_pending_schedule_then_the_limit() {
        let zone = FixedZone(0);
        let now = epoch_ms(2026, 10, 13, 12, 0, 0);
        assert_eq!(limit_resume_label(Some(&at(13, 16, 15, 0)), &limit(0), now, &zone).as_deref(), Some("Continues at 4:15 PM"));
        assert_eq!(limit_resume_label(Some(&at(13, 11, 59, 0)), &limit(0), now, &zone).as_deref(), Some("Continues shortly"));
        assert_eq!(limit_resume_label(None, &limit(0), now, &zone).as_deref(), Some("Continue at 4:10 PM"));
        let none = UsageLimit { provider: Provider::Claude, account_id: None, resets_at: None };
        assert_eq!(limit_resume_label(None, &none, now, &zone), None);
    }
}

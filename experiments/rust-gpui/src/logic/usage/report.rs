//! After `packages/shared/src/usage.ts`: usage tones, percent and reset labels, snapshot merging, account groups
//! and the context ring. Times are `i64` milliseconds since the epoch (`now`), ISO strings as the host sends them.

use super::time::{self, DAY, HOUR, MINUTE, Zone};
use super::tokens::format_tokens;
use crate::data::{Provider, UsageStatus};
use crate::logic::copy::js;

/// Picker order of the providers (`PROVIDERS` in `providers.mjs`; not the order of [`Provider::ALL`]).
pub const PROVIDER_ORDER: [Provider; 4] = [Provider::Codex, Provider::Claude, Provider::Antigravity, Provider::Kiro];

/// `UsageDisplay`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UsageDisplay {
    #[default]
    Used,
    Remaining,
}

/// `UsageTone`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageTone {
    Normal,
    Warning,
    Critical,
}

/// `usageTone`: warning from 80 % and critical from 95 %, on the rounded percent.
pub fn usage_tone(used_percent: f64) -> UsageTone {
    let rounded = js::round(used_percent);
    if rounded >= 95.0 {
        UsageTone::Critical
    } else if rounded >= 80.0 {
        UsageTone::Warning
    } else {
        UsageTone::Normal
    }
}

/// `formatPercent`: "46%".
pub fn format_percent(used_percent: f64) -> String {
    format!("{}%", js::number_string(js::round(used_percent)))
}

/// `shownPercent`: what's been used, or what's left of the window.
pub fn shown_percent(used_percent: f64, display: UsageDisplay) -> f64 {
    match display {
        UsageDisplay::Remaining => (100.0 - used_percent).max(0.0),
        UsageDisplay::Used => used_percent,
    }
}

/// `shownSuffix`.
pub fn shown_suffix(display: UsageDisplay) -> &'static str {
    match display {
        UsageDisplay::Remaining => "left",
        UsageDisplay::Used => "used",
    }
}

/// `formatResetsIn`: "Resets in 12m", "Resets in 3h 5m", "Resets in 2d 4h", "Resetting…".
pub fn format_resets_in(resets_at: Option<&str>, now: i64) -> Option<String> {
    let target = time::parse_iso_ms(resets_at.filter(|text| !text.is_empty())?)?;
    let remaining = target - now;
    Some(if remaining <= 0 {
        "Resetting\u{2026}".to_string()
    } else if remaining < HOUR {
        format!("Resets in {}m", ((remaining + MINUTE - 1) / MINUTE).max(1))
    } else if remaining < DAY {
        format!("Resets in {}h {}m", remaining / HOUR, remaining % HOUR / MINUTE)
    } else {
        format!("Resets in {}d {}h", remaining / DAY, remaining % DAY / HOUR)
    })
}

/// `formatUpdatedAgo`: "Updated just now", "Updated 5m ago", "Updated 3h ago", "Updated 2d ago". An unparseable
/// time or one in the future (clock skew) reads "just now".
pub fn format_updated_ago(updated_at: &str, now: i64) -> String {
    let Some(at) = time::parse_iso_ms(updated_at) else { return "Updated just now".to_string() };
    let elapsed = now - at;
    if elapsed < MINUTE {
        "Updated just now".to_string()
    } else if elapsed < HOUR {
        format!("Updated {}m ago", elapsed / MINUTE)
    } else if elapsed < DAY {
        format!("Updated {}h ago", elapsed / HOUR)
    } else {
        format!("Updated {}d ago", elapsed / DAY)
    }
}

/// `formatResetsAt`: short windows use a countdown; longer ones show the reset in the viewer's local time, as
/// "Resets Thu 16:10" (see [`time`] for the locale this reproduces).
pub fn format_resets_at(resets_at: Option<&str>, now: i64, zone: &dyn Zone) -> Option<String> {
    let text = resets_at.filter(|text| !text.is_empty())?;
    let at = time::parse_iso_ms(text)?;
    if at - now < DAY {
        return format_resets_in(Some(text), now);
    }
    let local = time::local_time(at, zone);
    Some(format!("Resets {} {}", local.weekday_short(), local.time_24h()))
}

/// The Account a usage read was taken for (`ProviderUsage.account`, trimmed to what the labels read).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountRef {
    pub id: String,
    pub label: String,
    pub email: Option<String>,
}

/// `UsageWindow`.
#[derive(Clone, Debug, PartialEq)]
pub struct WindowUsage {
    pub id: String,
    pub label: String,
    pub short_label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
    pub detail: Option<String>,
}

/// `ProviderUsage`: one provider's limits for one Account.
#[derive(Clone, Debug, PartialEq)]
pub struct AccountUsage {
    pub account: Option<AccountRef>,
    pub provider: Provider,
    pub status: UsageStatus,
    pub windows: Vec<WindowUsage>,
    pub updated_at: String,
    pub banked_resets: Option<u32>,
}

/// `UsageSnapshot`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageSnapshot {
    pub account_key: Option<String>,
    pub generated_at: Option<String>,
    pub providers: Vec<AccountUsage>,
}

/// `overviewUpdatedAt`: the oldest last-good read, so a fresh account never makes another account's stale data
/// look current. ISO string, or `None` when no provider has windows.
pub fn overview_updated_at(snapshot: Option<&UsageSnapshot>) -> Option<String> {
    let oldest =
        snapshot?.providers.iter().filter(|item| !item.windows.is_empty()).filter_map(|item| time::parse_iso_ms(&item.updated_at)).min()?;
    Some(time::format_iso(oldest))
}

/// `visibleProviders`: those with numbers. One in error keeps showing its last-known windows.
pub fn visible_providers(snapshot: &UsageSnapshot) -> Vec<&AccountUsage> {
    snapshot.providers.iter().filter(|item| item.status != UsageStatus::Unavailable && !item.windows.is_empty()).collect()
}

/// `usageLabel`: "Claude (me@work.com) usage, last known: 5h 40% used, wk 12% used".
pub fn usage_label(usage: &AccountUsage, display: UsageDisplay) -> String {
    let account = usage.account.as_ref().and_then(|account| match (&account.email, &account.label) {
        (Some(email), _) if !email.is_empty() => Some(email.as_str()),
        (_, label) if !label.is_empty() => Some(label.as_str()),
        _ => None,
    });
    let name = match account {
        Some(account) => format!("{} ({account})", usage.provider.name()),
        None => usage.provider.name().to_string(),
    };
    if usage.windows.is_empty() {
        return format!("{name} usage unavailable");
    }
    let windows: Vec<String> = usage
        .windows
        .iter()
        .take(2)
        .map(|item| format!("{} {} {}", item.label, format_percent(shown_percent(item.used_percent, display)), shown_suffix(display)))
        .collect();
    let last_known = if usage.status == UsageStatus::Error { ", last known" } else { "" };
    format!("{name} usage{last_known}: {}", windows.join(", "))
}

/// `seedSnapshot`: the saved numbers only seed an empty snapshot; a fresh read that landed first wins.
pub fn seed_snapshot(current: Option<UsageSnapshot>, cached: &UsageSnapshot) -> Option<UsageSnapshot> {
    if current.is_some() || cached.providers.is_empty() { current } else { Some(cached.clone()) }
}

/// `mergeSnapshot`: a failed refresh keeps the last good windows and their timestamp, so the card stays useful
/// and "Updated Xm ago" stays truthful while showing the error. Windows that have reset since are dropped.
pub fn merge_snapshot(previous: Option<&UsageSnapshot>, next: &UsageSnapshot, now: i64) -> UsageSnapshot {
    let previous = previous.filter(|previous| previous.account_key == next.account_key);
    let providers = next
        .providers
        .iter()
        .map(|current| {
            if current.status != UsageStatus::Error {
                return current.clone();
            }
            let before = previous.and_then(|previous| {
                previous.providers.iter().find(|item| {
                    item.provider == current.provider && item.account.as_ref().map(|a| &a.id) == current.account.as_ref().map(|a| &a.id)
                })
            });
            let Some(before) = before.filter(|before| !before.windows.is_empty()) else { return current.clone() };
            let windows = before
                .windows
                .iter()
                .filter(|item| match item.resets_at.as_deref().filter(|text| !text.is_empty()) {
                    None => true,
                    Some(text) => time::parse_iso_ms(text).is_some_and(|at| at > now),
                })
                .cloned()
                .collect();
            let mut merged = AccountUsage { windows, updated_at: before.updated_at.clone(), ..current.clone() };
            if before.banked_resets.is_some_and(|banked| banked > 0) {
                merged.banked_resets = before.banked_resets;
            }
            merged
        })
        .collect();
    UsageSnapshot {
        account_key: next.account_key.clone().filter(|key| !key.is_empty()),
        generated_at: next.generated_at.clone().filter(|at| !at.is_empty()),
        providers,
    }
}

/// `accountUsageGroups`: all Accounts stay separate, grouped by provider in picker order.
pub fn account_usage_groups(snapshot: Option<&UsageSnapshot>) -> Vec<(Provider, Vec<&AccountUsage>)> {
    PROVIDER_ORDER
        .into_iter()
        .map(|provider| {
            (
                provider,
                snapshot.map(|snapshot| snapshot.providers.iter().filter(|item| item.provider == provider).collect()).unwrap_or_default(),
            )
        })
        .filter(|(_, accounts): &(Provider, Vec<&AccountUsage>)| !accounts.is_empty())
        .collect()
}

/// What `contextSummary` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextSummary {
    pub ratio: f64,
    pub percent: i64,
    /// "120k of 200k tokens".
    pub tokens: String,
    /// "80k left".
    pub left: String,
}

/// `contextSummary`: how full the agent's context window is.
pub fn context_summary(used: f64, size: f64) -> ContextSummary {
    let ratio = if size > 0.0 { (used / size).clamp(0.0, 1.0) } else { 0.0 };
    ContextSummary {
        ratio,
        percent: js::round_i64(ratio * 100.0),
        tokens: format!("{} of {} tokens", format_tokens(used), format_tokens(size)),
        left: format!("{} left", format_tokens((size - used).max(0.0))),
    }
}

/// From here the ring turns to the accent colour.
pub const CONTEXT_WARN_PERCENT: i64 = 75;
/// From here the ring turns red.
pub const CONTEXT_CRITICAL_PERCENT: i64 = 90;

/// `contextTone`.
pub fn context_tone(percent: i64) -> UsageTone {
    if percent >= CONTEXT_CRITICAL_PERCENT {
        UsageTone::Critical
    } else if percent >= CONTEXT_WARN_PERCENT {
        UsageTone::Warning
    } else {
        UsageTone::Normal
    }
}

/// `contextHint`: explains the warning threshold; the button supplies the action.
pub fn context_hint(percent: i64) -> Option<String> {
    (percent >= CONTEXT_WARN_PERCENT)
        .then(|| format!("Context above {CONTEXT_WARN_PERCENT}% may reduce response quality and slow replies."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::usage::time::{FixedZone, epoch_ms};

    const NOW: i64 = 1_794_139_200_000; // 2026-11-08T12:00:00Z

    fn window(label: &str, used: f64, resets: Option<&str>) -> WindowUsage {
        WindowUsage {
            id: label.into(),
            label: label.into(),
            short_label: label.into(),
            used_percent: used,
            resets_at: resets.map(Into::into),
            detail: None,
        }
    }

    fn usage(provider: Provider, id: &str, status: UsageStatus, windows: Vec<WindowUsage>, updated_at: &str) -> AccountUsage {
        AccountUsage {
            account: Some(AccountRef { id: id.into(), label: id.into(), email: None }),
            provider,
            status,
            windows,
            updated_at: updated_at.into(),
            banked_resets: None,
        }
    }

    #[test]
    fn tones_switch_at_80_and_95_on_the_rounded_percent() {
        assert_eq!(usage_tone(79.4), UsageTone::Normal);
        assert_eq!(usage_tone(79.5), UsageTone::Warning);
        assert_eq!(usage_tone(94.4), UsageTone::Warning);
        assert_eq!(usage_tone(94.5), UsageTone::Critical);
        assert_eq!(usage_tone(100.0), UsageTone::Critical);
        assert_eq!(usage_tone(0.0), UsageTone::Normal);
    }

    #[test]
    fn percent_labels() {
        assert_eq!(format_percent(46.4), "46%");
        assert_eq!(format_percent(2.5), "3%");
        assert_eq!(shown_percent(30.0, UsageDisplay::Used), 30.0);
        assert_eq!(shown_percent(30.0, UsageDisplay::Remaining), 70.0);
        assert_eq!(shown_percent(130.0, UsageDisplay::Remaining), 0.0);
        assert_eq!(shown_suffix(UsageDisplay::Used), "used");
        assert_eq!(shown_suffix(UsageDisplay::Remaining), "left");
    }

    #[test]
    fn resets_in_counts_down_in_the_two_largest_units() {
        let at = |ms: i64| Some(time::format_iso(NOW + ms));
        assert_eq!(format_resets_in(None, NOW), None);
        assert_eq!(format_resets_in(Some("nope"), NOW), None);
        assert_eq!(format_resets_in(at(-1).as_deref(), NOW).as_deref(), Some("Resetting…"));
        assert_eq!(format_resets_in(at(0).as_deref(), NOW).as_deref(), Some("Resetting…"));
        assert_eq!(format_resets_in(at(1).as_deref(), NOW).as_deref(), Some("Resets in 1m"));
        assert_eq!(format_resets_in(at(61_000).as_deref(), NOW).as_deref(), Some("Resets in 2m"));
        assert_eq!(format_resets_in(at(HOUR - 1).as_deref(), NOW).as_deref(), Some("Resets in 60m"));
        assert_eq!(format_resets_in(at(HOUR).as_deref(), NOW).as_deref(), Some("Resets in 1h 0m"));
        assert_eq!(format_resets_in(at(3 * HOUR + 5 * MINUTE + 59_000).as_deref(), NOW).as_deref(), Some("Resets in 3h 5m"));
        assert_eq!(format_resets_in(at(DAY).as_deref(), NOW).as_deref(), Some("Resets in 1d 0h"));
        assert_eq!(format_resets_in(at(2 * DAY + 4 * HOUR + 30 * MINUTE).as_deref(), NOW).as_deref(), Some("Resets in 2d 4h"));
    }

    #[test]
    fn updated_ago_handles_skew_and_garbage() {
        let ago = |ms: i64| format_updated_ago(&time::format_iso(NOW - ms), NOW);
        assert_eq!(ago(59_999), "Updated just now");
        assert_eq!(ago(-5000), "Updated just now");
        assert_eq!(ago(MINUTE), "Updated 1m ago");
        assert_eq!(ago(HOUR - 1), "Updated 59m ago");
        assert_eq!(ago(HOUR), "Updated 1h ago");
        assert_eq!(ago(DAY), "Updated 1d ago");
        assert_eq!(ago(3 * DAY + HOUR), "Updated 3d ago");
        assert_eq!(format_updated_ago("garbage", NOW), "Updated just now");
    }

    #[test]
    fn resets_at_switches_to_local_time_from_a_day_out() {
        let near = time::format_iso(NOW + 5 * HOUR);
        assert_eq!(format_resets_at(Some(&near), NOW, &FixedZone(0)).as_deref(), Some("Resets in 5h 0m"));
        // Thu 2026-11-12 16:10 UTC.
        let far = time::format_iso(epoch_ms(2026, 11, 12, 16, 10, 0));
        assert_eq!(format_resets_at(Some(&far), NOW, &FixedZone(0)).as_deref(), Some("Resets Thu 16:10"));
        assert_eq!(format_resets_at(Some(&far), NOW, &FixedZone(9 * 60)).as_deref(), Some("Resets Fri 01:10"));
        assert_eq!(format_resets_at(Some(&far), NOW, &FixedZone(-8 * 60)).as_deref(), Some("Resets Thu 08:10"));
        assert_eq!(format_resets_at(None, NOW, &FixedZone(0)), None);
        assert_eq!(format_resets_at(Some("x"), NOW, &FixedZone(0)), None);
    }

    #[test]
    fn overview_uses_the_oldest_read_that_has_windows() {
        let snapshot = UsageSnapshot {
            providers: vec![
                usage(Provider::Claude, "a", UsageStatus::Ok, vec![window("5h", 1.0, None)], "2026-11-08T11:00:00.000Z"),
                usage(Provider::Codex, "b", UsageStatus::Ok, vec![window("5h", 1.0, None)], "2026-11-08T10:00:00.000Z"),
                usage(Provider::Kiro, "c", UsageStatus::Ok, vec![], "2026-11-01T10:00:00.000Z"),
            ],
            ..Default::default()
        };
        assert_eq!(overview_updated_at(Some(&snapshot)).as_deref(), Some("2026-11-08T10:00:00.000Z"));
        assert_eq!(overview_updated_at(None), None);
        assert_eq!(overview_updated_at(Some(&UsageSnapshot::default())), None);
    }

    #[test]
    fn the_sidebar_shows_providers_with_numbers() {
        let snapshot = UsageSnapshot {
            providers: vec![
                usage(Provider::Claude, "a", UsageStatus::Ok, vec![window("5h", 1.0, None)], ""),
                usage(Provider::Codex, "b", UsageStatus::Unavailable, vec![window("5h", 1.0, None)], ""),
                usage(Provider::Kiro, "c", UsageStatus::Error, vec![window("mo", 1.0, None)], ""),
                usage(Provider::Antigravity, "d", UsageStatus::Ok, vec![], ""),
            ],
            ..Default::default()
        };
        let shown: Vec<Provider> = visible_providers(&snapshot).iter().map(|item| item.provider).collect();
        assert_eq!(shown, vec![Provider::Claude, Provider::Kiro]);
    }

    #[test]
    fn labels_name_the_account_and_say_when_numbers_are_stale() {
        let mut item = usage(
            Provider::Claude,
            "work",
            UsageStatus::Ok,
            vec![window("5h", 40.4, None), window("wk", 12.0, None), window("x", 1.0, None)],
            "",
        );
        item.account = Some(AccountRef { id: "work".into(), label: "Work".into(), email: Some("me@work.com".into()) });
        assert_eq!(usage_label(&item, UsageDisplay::Used), "Claude (me@work.com) usage: 5h 40% used, wk 12% used");
        assert_eq!(usage_label(&item, UsageDisplay::Remaining), "Claude (me@work.com) usage: 5h 60% left, wk 88% left");
        item.status = UsageStatus::Error;
        item.account = Some(AccountRef { id: "work".into(), label: "Work".into(), email: Some(String::new()) });
        assert_eq!(usage_label(&item, UsageDisplay::Used), "Claude (Work) usage, last known: 5h 40% used, wk 12% used");
        item.account = None;
        item.windows.clear();
        assert_eq!(usage_label(&item, UsageDisplay::Used), "Claude usage unavailable");
    }

    #[test]
    fn a_saved_snapshot_only_seeds_an_empty_one() {
        let cached = UsageSnapshot { providers: vec![usage(Provider::Claude, "a", UsageStatus::Ok, vec![], "")], ..Default::default() };
        assert_eq!(seed_snapshot(None, &cached), Some(cached.clone()));
        let fresh = UsageSnapshot::default();
        assert_eq!(seed_snapshot(Some(fresh.clone()), &cached), Some(fresh));
        assert_eq!(seed_snapshot(None, &UsageSnapshot::default()), None);
    }

    #[test]
    fn a_failed_refresh_keeps_the_last_good_windows_that_have_not_reset() {
        let future = time::format_iso(NOW + HOUR);
        let past = time::format_iso(NOW - HOUR);
        let mut good = usage(
            Provider::Claude,
            "a",
            UsageStatus::Ok,
            vec![
                window("5h", 10.0, Some(&past)),
                window("wk", 20.0, Some(&future)),
                window("mo", 30.0, None),
                window("bad", 5.0, Some("garbage")),
            ],
            "2026-11-08T11:00:00.000Z",
        );
        good.banked_resets = Some(2);
        let previous = UsageSnapshot { account_key: Some("k".into()), generated_at: Some("g".into()), providers: vec![good] };
        let failed = usage(Provider::Claude, "a", UsageStatus::Error, vec![], "2026-11-08T11:59:00.000Z");
        let other = usage(Provider::Codex, "z", UsageStatus::Ok, vec![window("5h", 1.0, None)], "x");
        let next = UsageSnapshot {
            account_key: Some("k".into()),
            generated_at: Some("g2".into()),
            providers: vec![failed.clone(), other.clone()],
        };
        let merged = merge_snapshot(Some(&previous), &next, NOW);
        assert_eq!(merged.generated_at.as_deref(), Some("g2"));
        let kept = &merged.providers[0];
        let labels: Vec<&str> = kept.windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, vec!["wk", "mo"]);
        assert_eq!(kept.updated_at, "2026-11-08T11:00:00.000Z");
        assert_eq!(kept.banked_resets, Some(2));
        assert_eq!(kept.status, UsageStatus::Error);
        assert_eq!(merged.providers[1], other);
        // Another account's snapshot is never merged in.
        let moved = UsageSnapshot { account_key: Some("other".into()), ..next.clone() };
        assert_eq!(merge_snapshot(Some(&previous), &moved, NOW).providers[0], failed);
        // A different Account of the same provider is not the same read.
        let sibling = UsageSnapshot { providers: vec![usage(Provider::Claude, "b", UsageStatus::Error, vec![], "y")], ..next.clone() };
        assert!(merge_snapshot(Some(&previous), &sibling, NOW).providers[0].windows.is_empty());
        assert_eq!(merge_snapshot(None, &next, NOW).providers[0], failed);
    }

    #[test]
    fn account_groups_follow_picker_order_and_skip_empty_ones() {
        let snapshot = UsageSnapshot {
            providers: vec![
                usage(Provider::Kiro, "k", UsageStatus::Ok, vec![], ""),
                usage(Provider::Claude, "c1", UsageStatus::Ok, vec![], ""),
                usage(Provider::Claude, "c2", UsageStatus::Ok, vec![], ""),
                usage(Provider::Codex, "default", UsageStatus::Ok, vec![], ""),
            ],
            ..Default::default()
        };
        let groups = account_usage_groups(Some(&snapshot));
        let shape: Vec<(Provider, usize)> = groups.iter().map(|(p, a)| (*p, a.len())).collect();
        assert_eq!(shape, vec![(Provider::Codex, 1), (Provider::Claude, 2), (Provider::Kiro, 1)]);
        assert!(account_usage_groups(None).is_empty());
    }

    #[test]
    fn the_context_ring() {
        let summary = context_summary(150_000.0, 200_000.0);
        assert_eq!((summary.ratio, summary.percent), (0.75, 75));
        assert_eq!(summary.tokens, "150k of 200k tokens");
        assert_eq!(summary.left, "50k left");
        assert_eq!(context_summary(300_000.0, 200_000.0).percent, 100);
        assert_eq!(context_summary(300_000.0, 200_000.0).left, "0 left");
        assert_eq!(context_summary(10.0, 0.0).percent, 0);
        assert_eq!(context_summary(-5.0, 100.0).ratio, 0.0);
        assert_eq!(context_tone(74), UsageTone::Normal);
        assert_eq!(context_tone(75), UsageTone::Warning);
        assert_eq!(context_tone(89), UsageTone::Warning);
        assert_eq!(context_tone(90), UsageTone::Critical);
        assert_eq!(context_hint(74), None);
        assert_eq!(context_hint(75).as_deref(), Some("Context above 75% may reduce response quality and slow replies."));
    }
}

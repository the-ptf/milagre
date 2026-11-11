//! After `packages/shared/src/new-chat-glance.ts`: a new Chat's glance (the repository's open PRs, plan usage and
//! today's token usage), pure so both platforms show the same rows and numbers.
//!
//! The token usage report is not modelled in `src/data`; [`TokenReport`] holds the fields `glanceToday` reads.

use super::time::{self, Zone};
use crate::data::Provider;
use crate::logic::prs::blockers::{Checks, PrState, PullRequestStatus};

/// Settings › Chat: the switch that shows the glance (off by default), with the same words on desktop and phone.
/// (The TypeScript comment says "Settings › Church"; the strings are what is shared.)
pub const NEW_CHAT_STATS_LABEL: &str = "New Chat stats";
pub const NEW_CHAT_STATS_HINT: &str = "Open pull requests, plan usage and today's tokens on a new Chat.";

/// At most this many PRs on the card; the rest are left out, not summarised.
pub const GLANCE_PR_LIMIT: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlancePrTone {
    Green,
    Orange,
    Red,
    Purple,
    Muted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlancePullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    /// "checks passing", "CI running", "changes requested"...
    pub status: &'static str,
    pub tone: GlancePrTone,
    pub draft: bool,
    /// Since its last update: "2d". Empty when the host didn't say.
    pub age: String,
}

/// `pullRequestStatus`: where an open PR stands, worst first.
pub fn pull_request_status(pr: &PullRequestStatus) -> (&'static str, GlancePrTone) {
    if pr.is_draft {
        ("draft", GlancePrTone::Muted)
    } else if pr.has_conflicts {
        ("conflicts", GlancePrTone::Red)
    } else if pr.checks == Some(Checks::Failed) {
        ("CI failed", GlancePrTone::Red)
    } else if pr.changes_requested {
        ("changes requested", GlancePrTone::Orange)
    } else if pr.checks == Some(Checks::Running) {
        ("CI running", GlancePrTone::Orange)
    } else if pr.is_behind {
        ("behind base", GlancePrTone::Orange)
    } else if pr.ready_to_merge {
        ("ready to merge", GlancePrTone::Purple)
    } else {
        ("checks passing", GlancePrTone::Green)
    }
}

/// An open PR as the host's `pull-requests:open` lists it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenPullRequest {
    pub pr: PullRequestStatus,
    pub updated_at: Option<String>,
}

/// `shortAge`: how long ago, shortest first: "now", "12m", "3h", "2d", "5w".
pub fn short_age(iso: Option<&str>, now: i64) -> String {
    let Some(at) = iso.and_then(time::parse_iso_ms) else { return String::new() };
    let minutes = ((now - at) / time::MINUTE).max(0);
    if minutes < 1 {
        return "now".to_string();
    }
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = hours / 24;
    if days < 14 { format!("{days}d") } else { format!("{}w", days / 7) }
}

/// `openPullRequestRows`: open PRs only, once each (by URL), in the order the host listed them.
pub fn open_pull_request_rows(list: Option<&[OpenPullRequest]>, now: i64) -> Vec<GlancePullRequest> {
    let mut seen: Vec<&str> = Vec::new();
    let mut rows = Vec::new();
    for item in list.unwrap_or_default() {
        let pr = &item.pr;
        if pr.state != PrState::Open || seen.contains(&pr.url.as_str()) {
            continue;
        }
        seen.push(&pr.url);
        let (status, tone) = pull_request_status(pr);
        rows.push(GlancePullRequest {
            number: pr.number.unwrap_or_default(),
            title: pr.title.clone(),
            url: pr.url.clone(),
            status,
            tone,
            draft: pr.is_draft,
            age: short_age(item.updated_at.as_deref(), now),
        });
    }
    rows
}

/// `todayKey`: today in the device's time zone, as the token usage report names days ("2026-11-08").
pub fn today_key(now: i64, zone: &dyn Zone) -> String {
    time::day_key(now, zone)
}

/// Tokens and cost of one provider in a bucket (`TokenUsageSplit` entry).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TokenSplit {
    pub tokens: f64,
    pub cost_usd: f64,
}

/// `TokenUsageBucket`: the start (ms) and the per-provider split.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenBucket {
    pub start: i64,
    pub providers: Vec<(Provider, TokenSplit)>,
}

/// `TokenCounts` plus the cost: what `tokenTotal` and the glance read of `totals`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TokenTotals {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub cost_usd: f64,
}

/// `tokenTotal`: uncached input, cache reads, cache writes and output.
pub fn token_total(totals: &TokenTotals) -> f64 {
    totals.input + totals.cache_read + totals.cache_write + totals.output
}

/// `TokenUsageProject`, trimmed to what the glance counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenProject {
    pub milagre: bool,
    pub count: u32,
}

/// `TokenUsageReport`, trimmed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TokenReport {
    pub totals: TokenTotals,
    pub series: Vec<TokenBucket>,
    pub projects: Vec<TokenProject>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GlanceToday {
    pub cost_usd: f64,
    pub tokens: f64,
    /// Chats and sessions with a request today, in Milagre's Projects, Chats homes and Links.
    pub chats: u32,
    /// Cost per hour of the day, 0 to 23 (tokens where nothing is priced).
    pub hours: [f64; 24],
    /// The hour now, so the bars after it read as still to come.
    pub current_hour: u32,
}

/// `glanceToday`: today's totals and its hours, from a one-day token usage report (which reads by the hour).
pub fn glance_today(report: Option<&TokenReport>, now: i64, zone: &dyn Zone) -> Option<GlanceToday> {
    let report = report?;
    let priced = report.totals.cost_usd > 0.0;
    let mut hours = [0.0; 24];
    for bucket in &report.series {
        let hour = time::local_time(bucket.start, zone).hour as usize;
        for (_, split) in &bucket.providers {
            hours[hour] += if priced { split.cost_usd } else { split.tokens };
        }
    }
    let chats = report.projects.iter().filter(|project| project.milagre).map(|project| project.count).sum();
    Some(GlanceToday {
        cost_usd: report.totals.cost_usd,
        tokens: token_total(&report.totals),
        chats,
        hours,
        current_hour: time::local_time(now, zone).hour as u32,
    })
}

/// `hourShares`: each hour's bar height as a share of the busiest hour, 0 to 1.
pub fn hour_shares(hours: &[f64]) -> Vec<f64> {
    let peak = hours.iter().copied().fold(0.0, f64::max);
    hours.iter().map(|value| if peak > 0.0 { value / peak } else { 0.0 }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::usage::time::{FixedZone, epoch_ms, parse_iso_ms};

    fn pr(number: u32) -> PullRequestStatus {
        PullRequestStatus {
            number: Some(number),
            title: format!("PR {number}"),
            url: format!("https://github.com/o/r/pull/{number}"),
            ..Default::default()
        }
    }

    fn open(pr: PullRequestStatus, updated_at: Option<&str>) -> OpenPullRequest {
        OpenPullRequest { pr, updated_at: updated_at.map(Into::into) }
    }

    #[test]
    fn open_pr_rows_open_only_once_each_with_their_age() {
        let now = parse_iso_ms("2026-11-08T12:00:00Z").unwrap();
        let list = [
            open(pr(930), Some("2026-11-07T11:00:00Z")),
            open(PullRequestStatus { state: PrState::Merged, ..pr(741) }, None),
            open(PullRequestStatus { checks: Some(Checks::Running), ..pr(896) }, Some("2026-11-08T11:20:00Z")),
            open(pr(930), None),
        ];
        let rows = open_pull_request_rows(Some(&list), now);
        let shape: Vec<(u32, &str, &str)> = rows.iter().map(|row| (row.number, row.age.as_str(), row.status)).collect();
        assert_eq!(shape, vec![(930, "1d", "checks passing"), (896, "40m", "CI running")]);
        assert_eq!(rows[0].title, "PR 930");
        assert!(open_pull_request_rows(None, now).is_empty());
    }

    #[test]
    fn short_age_reads_shortest_first() {
        let now = parse_iso_ms("2026-11-08T12:00:00Z").unwrap();
        assert_eq!(short_age(Some("2026-11-08T11:59:40Z"), now), "now");
        assert_eq!(short_age(Some("2026-11-08T11:30:00Z"), now), "30m");
        assert_eq!(short_age(Some("2026-11-08T09:00:00Z"), now), "3h");
        assert_eq!(short_age(Some("2026-10-26T12:00:00Z"), now), "13d");
        assert_eq!(short_age(Some("2026-10-25T12:00:00Z"), now), "2w");
        assert_eq!(short_age(Some("2026-10-01T12:00:00Z"), now), "5w");
        assert_eq!(short_age(Some("2026-11-09T12:00:00Z"), now), "now");
        assert_eq!(short_age(None, now), "");
        assert_eq!(short_age(Some("garbage"), now), "");
    }

    #[test]
    fn pr_status_names_the_worst_thing_first() {
        let status = |pr: PullRequestStatus| pull_request_status(&pr);
        assert_eq!(status(PullRequestStatus { is_draft: true, checks: Some(Checks::Failed), ..pr(1) }), ("draft", GlancePrTone::Muted));
        assert_eq!(
            status(PullRequestStatus { has_conflicts: true, checks: Some(Checks::Running), ..pr(1) }),
            ("conflicts", GlancePrTone::Red)
        );
        assert_eq!(status(PullRequestStatus { checks: Some(Checks::Failed), ..pr(1) }), ("CI failed", GlancePrTone::Red));
        assert_eq!(
            status(PullRequestStatus { changes_requested: true, checks: Some(Checks::Running), ..pr(1) }),
            ("changes requested", GlancePrTone::Orange)
        );
        assert_eq!(status(PullRequestStatus { checks: Some(Checks::Running), ..pr(1) }), ("CI running", GlancePrTone::Orange));
        assert_eq!(status(PullRequestStatus { is_behind: true, ready_to_merge: true, ..pr(1) }), ("behind base", GlancePrTone::Orange));
        assert_eq!(status(PullRequestStatus { ready_to_merge: true, ..pr(1) }), ("ready to merge", GlancePrTone::Purple));
        assert_eq!(status(pr(1)), ("checks passing", GlancePrTone::Green));
    }

    #[test]
    fn today_key_is_the_local_calendar_day() {
        for offset in [0, 9 * 60, -8 * 60] {
            let zone = FixedZone(offset);
            assert_eq!(today_key(epoch_ms(2026, 11, 8, 23, 59, offset), &zone), "2026-11-08");
            assert_eq!(today_key(epoch_ms(2026, 1, 3, 0, 1, offset), &zone), "2026-01-03");
        }
    }

    #[test]
    fn today_totals_milagre_chats_and_cost_per_hour() {
        for offset in [0, 9 * 60, -8 * 60] {
            let zone = FixedZone(offset);
            let at = |hour: i64| epoch_ms(2026, 11, 8, hour, 0, offset);
            let report = TokenReport {
                totals: TokenTotals { input: 3000.0, cost_usd: 3.0, ..Default::default() },
                series: vec![
                    TokenBucket {
                        start: at(9),
                        providers: vec![
                            (Provider::Claude, TokenSplit { tokens: 1000.0, cost_usd: 1.0 }),
                            (Provider::Codex, TokenSplit { tokens: 500.0, cost_usd: 0.5 }),
                        ],
                    },
                    TokenBucket { start: at(14), providers: vec![(Provider::Claude, TokenSplit { tokens: 1500.0, cost_usd: 1.5 })] },
                ],
                projects: vec![
                    TokenProject { milagre: true, count: 3 },
                    TokenProject { milagre: true, count: 2 },
                    TokenProject { milagre: false, count: 7 },
                ],
            };
            let today = glance_today(Some(&report), at(15), &zone).unwrap();
            assert_eq!((today.cost_usd, today.tokens, today.chats), (3.0, 3000.0, 5));
            assert_eq!((today.hours[9], today.hours[14], today.current_hour), (1.5, 1.5, 15));
            assert_eq!(glance_today(None, at(15), &zone), None);
        }
    }

    #[test]
    fn unpriced_days_count_tokens_per_hour() {
        let zone = FixedZone(0);
        let report = TokenReport {
            series: vec![TokenBucket {
                start: epoch_ms(2026, 11, 8, 2, 0, 0),
                providers: vec![(Provider::Codex, TokenSplit { tokens: 700.0, cost_usd: 0.0 })],
            }],
            ..Default::default()
        };
        assert_eq!(glance_today(Some(&report), epoch_ms(2026, 11, 8, 3, 0, 0), &zone).unwrap().hours[2], 700.0);
    }

    #[test]
    fn hour_shares_scale_to_the_busiest_hour() {
        assert_eq!(hour_shares(&[0.0, 2.0, 4.0]), vec![0.0, 0.5, 1.0]);
        assert_eq!(hour_shares(&[0.0, 0.0]), vec![0.0, 0.0]);
        assert_eq!(GLANCE_PR_LIMIT, 4);
    }

    #[test]
    fn the_settings_words_match_the_typescript_source() {
        let Some(ts) = crate::logic::copy::source::shared("new-chat-glance.ts") else { return };
        for text in [NEW_CHAT_STATS_LABEL, NEW_CHAT_STATS_HINT] {
            assert!(ts.contains(&format!("\"{text}\"")), "{text}");
        }
    }
}

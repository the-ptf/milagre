//! Fixture data for the Accounts and Usage pages: the answers `accounts:list`, `usage:accounts:read` and
//! `token-usage:read` would give, on the fixture clock of `data::fixture` (2026-11-11). Deterministic, so a
//! snapshot or a test sees the same numbers every time.

use std::collections::HashMap;

use super::model::{AccountEntry, AccountState, AccountsStore, CliRow, CliState, DEFAULT_ACCOUNT, ProviderAccount, ProviderGroup, Scope};
use super::plan::{PlanAccount, PlanSnapshot};
use super::token_usage::{
    ChatKind, ChatUsage, Day, Days, ModelUsage, PricingStatus, ProjectUsage, Range, Report, Split, SplitPoint, Totals, covered_days,
    token_total,
};
use crate::data::fixture::NOW;
use crate::data::{AccountRef, AccountUsage, Provider, UsageStatus, WindowUsage};
use crate::logic::usage::time::{self, DAY, HOUR, MINUTE};

fn account(id: &str, label: &str, email: Option<&str>, plan: Option<&str>, state: AccountState, message: Option<&str>) -> AccountEntry {
    AccountEntry {
        account: ProviderAccount {
            id: id.to_string(),
            label: label.to_string(),
            state,
            email: email.map(str::to_string),
            plan: plan.map(str::to_string),
            limited_until: None,
            missing: false,
        },
        message: message.map(Into::into),
    }
}

/// This Mac's accounts, with one scope per Project the data source lists, the Chats home and one Link.
pub fn accounts_store(projects: &[(String, String)]) -> AccountsStore {
    let ready = AccountState::Ready;
    let groups = vec![
        ProviderGroup {
            provider: Provider::Codex,
            installed: true,
            selected_id: DEFAULT_ACCOUNT.to_string(),
            accounts: vec![
                account(DEFAULT_ACCOUNT, "Personal", Some("victor@example.com"), Some("plus"), ready, None),
                account("codex-old", "Old team seat", Some("victor@oldteam.example"), Some("team"), AccountState::SignedOut, None),
            ],
        },
        ProviderGroup {
            provider: Provider::Claude,
            installed: true,
            selected_id: DEFAULT_ACCOUNT.to_string(),
            accounts: vec![
                account(DEFAULT_ACCOUNT, "Personal", Some("victor.lucas@example.com"), Some("max"), ready, None),
                account("claude-work", "Work", Some("victor@rdplus.com"), Some("team"), ready, None),
            ],
        },
        ProviderGroup { provider: Provider::Antigravity, installed: false, selected_id: DEFAULT_ACCOUNT.to_string(), accounts: Vec::new() },
        ProviderGroup {
            provider: Provider::Kiro,
            installed: true,
            selected_id: DEFAULT_ACCOUNT.to_string(),
            accounts: vec![account(
                DEFAULT_ACCOUNT,
                "Personal",
                Some("victor@kiro.example"),
                Some("pro"),
                ready,
                Some("Signed in with kiro-cli on this computer."),
            )],
        },
    ];
    let mut scopes: Vec<Scope> = projects
        .iter()
        .map(|(path, name)| Scope { key: path.clone(), name: name.clone(), link: false, projects: vec![name.clone()], chats_home: false })
        .collect();
    scopes.insert(0, Scope { key: "~chats".to_string(), name: "Chats".to_string(), link: false, projects: Vec::new(), chats_home: true });
    scopes.push(Scope {
        key: "link:desktop-phone".to_string(),
        name: "Desktop and phone".to_string(),
        link: true,
        projects: projects.iter().take(2).map(|(_, name)| name.clone()).collect(),
        chats_home: false,
    });
    let mut assignments = HashMap::new();
    if let Some((path, _)) = projects.first() {
        assignments.insert((path.clone(), Provider::Claude), "claude-work".to_string());
    }
    let cli = CliRow { state: Some(CliState::Missing), working: false, phase: None, error: String::new() };
    AccountsStore::new(groups, cli, scopes, assignments)
}

fn iso(at: i64) -> String {
    time::format_iso(at)
}

fn window(id: &str, label: &str, short: &str, used: f64, resets_in_minutes: i64, detail: Option<&str>) -> WindowUsage {
    WindowUsage {
        id: id.to_string(),
        label: label.to_string(),
        short_label: short.to_string(),
        used_percent: used,
        resets_at: Some(iso(NOW + resets_in_minutes * MINUTE)),
        detail: detail.map(str::to_string),
    }
}

#[allow(clippy::too_many_arguments)]
fn plan(
    provider: Provider,
    id: &str,
    label: &str,
    email: Option<&str>,
    status: UsageStatus,
    windows: Vec<WindowUsage>,
    updated_minutes_ago: i64,
    banked: Option<u32>,
    state: AccountState,
    message: Option<&str>,
) -> PlanAccount {
    PlanAccount {
        usage: AccountUsage {
            account: Some(AccountRef { id: id.to_string(), label: label.to_string(), email: email.map(str::to_string) }),
            provider,
            status,
            windows,
            updated_at: iso(NOW - updated_minutes_ago * MINUTE),
            banked_resets: banked,
        },
        state,
        message: message.map(Into::into),
    }
}

/// `usage:accounts:read` on the computer `computer` (`local` or a paired one): every account's limits.
pub fn plan_snapshot(local: bool) -> PlanSnapshot {
    let ready = AccountState::Ready;
    let mut accounts = vec![
        plan(
            Provider::Codex,
            DEFAULT_ACCOUNT,
            "Personal",
            Some("victor@example.com"),
            UsageStatus::Ok,
            vec![window("weekly", "Weekly", "wk", 86.0, 2 * 24 * 60 + 190, None)],
            3,
            Some(1),
            ready,
            None,
        ),
        plan(
            Provider::Codex,
            "codex-old",
            "Old team seat",
            Some("victor@oldteam.example"),
            UsageStatus::Unavailable,
            Vec::new(),
            200,
            None,
            AccountState::SignedOut,
            Some("Not signed in. Re-authenticate this account in Accounts."),
        ),
        plan(
            Provider::Claude,
            DEFAULT_ACCOUNT,
            "Personal",
            Some("victor.lucas@example.com"),
            UsageStatus::Ok,
            vec![
                window("five_hour", "5-hour", "5h", 34.0, 130, None),
                window("seven_day", "Weekly", "wk", 61.0, 3 * 24 * 60 + 400, None),
                window("seven_day_sonnet", "Sonnet weekly", "son", 18.0, 3 * 24 * 60 + 400, Some("Sonnet only")),
            ],
            2,
            None,
            ready,
            None,
        ),
        plan(
            Provider::Claude,
            "claude-work",
            "Work",
            Some("victor@rdplus.com"),
            UsageStatus::Error,
            vec![window("five_hour", "5-hour", "5h", 12.0, 95, None), window("seven_day", "Weekly", "wk", 82.0, 24 * 60 + 70, None)],
            180,
            None,
            ready,
            Some("Couldn't read usage: the Claude Code sign-in expired."),
        ),
        plan(
            Provider::Antigravity,
            DEFAULT_ACCOUNT,
            "Personal",
            Some("victor@example.com"),
            UsageStatus::Ok,
            vec![window("five_hour", "5-hour", "5h", 0.0, 300, None), window("weekly", "Weekly", "wk", 97.0, 30 * 60, None)],
            5,
            None,
            ready,
            None,
        ),
        plan(
            Provider::Kiro,
            DEFAULT_ACCOUNT,
            "Personal",
            Some("victor@kiro.example"),
            UsageStatus::Unavailable,
            Vec::new(),
            12,
            None,
            ready,
            Some("Kiro doesn't report plan usage."),
        ),
    ];
    if !local {
        // A paired computer is read as it last reported: its Codex account only.
        accounts.retain(|entry| entry.usage.provider != Provider::Claude);
    }
    PlanSnapshot { accounts, error: None }
}

/// 2026-11-11 is the last of the 90 calendar days.
const CALENDAR_DAYS: i64 = 90;

fn noise(i: i64, salt: i64) -> f64 {
    ((i * i * 31 + i * 17 + salt * 101) % 97) as f64 / 97.0
}

/// 0 is Sunday.
fn weekday_of(day: i64) -> i64 {
    (day + 4).rem_euclid(7)
}

/// The daily API-equivalent cost of each provider, in USD.
fn day_costs(i: i64, day: i64) -> (f64, f64) {
    let weekend = matches!(weekday_of(day), 0 | 6);
    let mut claude = if weekend { 4.0 + 25.0 * noise(i, 1).powi(2) } else { 18.0 + 70.0 * noise(i, 1) };
    let mut codex = if weekend { 0.0 } else { 6.0 + 26.0 * noise(i, 2) };
    if i % 11 == 4 {
        claude = 0.0;
        codex = 0.0;
    }
    if i == 71 {
        claude *= 3.2;
    }
    if i < 14 {
        let ramp = (i + 1) as f64 / 15.0;
        claude *= ramp;
        codex *= ramp;
    }
    if i == CALENDAR_DAYS - 1 {
        claude *= 0.55;
        codex *= 0.55;
    }
    (claude, codex)
}

/// How a provider's tokens divide across the four price categories, and what each costs per million tokens.
struct Mix {
    shares: [f64; 4],
    prices: [f64; 4],
    reasoning_of_output: f64,
}

const CLAUDE_MIX: Mix = Mix { shares: [0.02, 0.80, 0.06, 0.12], prices: [3.0, 0.30, 3.75, 15.0], reasoning_of_output: 0.2 };
const CODEX_MIX: Mix = Mix { shares: [0.05, 0.80, 0.0, 0.15], prices: [1.25, 0.125, 0.0, 10.0], reasoning_of_output: 0.35 };

impl Mix {
    /// Dollars per token.
    fn price_per_token(&self) -> f64 {
        self.shares.iter().zip(self.prices).map(|(share, price)| share * price).sum::<f64>() / 1e6
    }

    /// The totals of `cost_usd` spent at this mix.
    fn totals(&self, cost_usd: f64) -> Totals {
        let tokens = cost_usd / self.price_per_token();
        let [input, cache_read, cache_write, output] = self.shares.map(|share| tokens * share);
        let cost = |count: f64, price: f64| count * price / 1e6;
        Totals {
            input,
            cache_read,
            cache_write,
            output,
            reasoning: output * self.reasoning_of_output,
            requests: (tokens / 55_000.0).round(),
            cost_usd,
            cost: super::token_usage::CostSplit {
                input: cost(input, self.prices[0]),
                cache_read: cost(cache_read, self.prices[1]),
                cache_write: cost(cache_write, self.prices[2]),
                output: cost(output, self.prices[3]),
            },
            cache_savings_usd: cache_read * (self.prices[0] - self.prices[1]) / 1e6,
            unpriced_tokens: 0.0,
        }
    }
}

/// The 90 calendar days and each provider's cost per day.
fn calendar() -> Vec<(Day, f64, f64)> {
    let today = time::days_from_civil(1970, 1, 1) + NOW.div_euclid(DAY);
    (0..CALENDAR_DAYS)
        .map(|i| {
            let day = today - (CALENDAR_DAYS - 1 - i);
            let (claude, codex) = day_costs(i, day);
            let (year, month, date) = time::civil_from_days(day);
            let tokens = claude / CLAUDE_MIX.price_per_token() + codex / CODEX_MIX.price_per_token();
            (Day { key: format!("{year:04}-{month:02}-{date:02}"), start: day * DAY, tokens, cost_usd: claude + codex }, claude, codex)
        })
        .collect()
}

/// One model's share of a provider's totals; an unpriced model costs nothing and counts as unpriced tokens.
fn model_usage(provider: Provider, model: &str, share: f64, base: &Totals, priced: bool) -> ModelUsage {
    let mut totals = base.scaled(share);
    if !priced {
        totals.unpriced_tokens = token_total(&totals);
        totals.cost_usd = 0.0;
        totals.cost = Default::default();
        totals.cache_savings_usd = 0.0;
    }
    ModelUsage { provider, model: model.to_string(), priced, totals }
}

struct ProjectSpec {
    path: &'static str,
    name: &'static str,
    milagre: bool,
    /// The project's share of Claude's and of Codex's totals.
    shares: (f64, f64),
    /// Chat title, kind, shares of the project's totals and the folder path of an outside session.
    chats: &'static [(&'static str, ChatKind, f64, &'static str)],
    /// What the chats past the listed ones hold, in count and share.
    rest: (u32, f64),
}

const PROJECTS: [ProjectSpec; 5] = [
    ProjectSpec {
        path: "/Users/victor/Code/personal/milagre-ade",
        name: "milagre-ade",
        milagre: true,
        shares: (0.42, 0.35),
        chats: &[
            ("Accounts and usage settings port", ChatKind::Chat, 0.22, ""),
            ("Sidebar flash when switching Chats", ChatKind::Chat, 0.17, ""),
            ("Perf audit follow-ups", ChatKind::Chat, 0.14, ""),
            ("Design council, round eight", ChatKind::Archived, 0.11, ""),
            ("Routine run page", ChatKind::Chat, 0.09, ""),
            ("Terminal scrollback", ChatKind::Chat, 0.07, ""),
        ],
        rest: (12, 0.20),
    },
    ProjectSpec {
        path: "/Users/victor/Code/personal/happiergym",
        name: "happiergym",
        milagre: true,
        shares: (0.26, 0.18),
        chats: &[
            ("Watch connectivity retries", ChatKind::Chat, 0.41, ""),
            ("Workout export to Health", ChatKind::Chat, 0.33, ""),
            ("Join links", ChatKind::Chat, 0.16, ""),
        ],
        rest: (2, 0.10),
    },
    ProjectSpec {
        path: "/Users/victor/Code/rdplus/pdv",
        name: "rdplus-pdv",
        milagre: true,
        shares: (0.12, 0.22),
        chats: &[("Receipt printer driver", ChatKind::Chat, 0.58, ""), ("Offline sync queue", ChatKind::Chat, 0.42, "")],
        rest: (0, 0.0),
    },
    ProjectSpec {
        path: "~chats",
        name: "Chats",
        milagre: true,
        shares: (0.05, 0.05),
        chats: &[("Which CI runner is cheaper", ChatKind::Chat, 0.64, ""), ("Regex for ISO dates", ChatKind::Chat, 0.36, "")],
        rest: (0, 0.0),
    },
    ProjectSpec {
        path: "",
        name: "Outside Milagre",
        milagre: false,
        shares: (0.15, 0.20),
        chats: &[
            ("tools", ChatKind::Folder, 0.46, "~/Code/tools"),
            ("scratch", ChatKind::Folder, 0.31, "~/Desktop/scratch"),
            ("dotfiles", ChatKind::Folder, 0.23, "~/.config"),
        ],
        rest: (0, 0.0),
    },
];

/// `token-usage:read` for a `range` or the picked `days`, on this computer (`scale` 1.0) or a paired one.
pub fn token_report(range: Range, days: Option<&Days>, scale: f64) -> Report {
    let calendar_rows = calendar();
    let calendar: Vec<Day> = calendar_rows.iter().map(|(day, _, _)| day.clone()).collect();
    let (since, until) = match days {
        Some(days) => {
            let start = |key: &str| calendar.iter().find(|day| day.key == key).map_or(NOW - DAY, |day| day.start);
            let (low, high) = if days.from <= days.to { (&days.from, &days.to) } else { (&days.to, &days.from) };
            (start(low), (start(high) + DAY).min(NOW))
        }
        None => (NOW - range.span_days() * DAY, NOW),
    };
    // Each day counts for the part of it inside the period.
    let (mut claude_cost, mut codex_cost) = (0.0, 0.0);
    for (day, claude, codex) in &calendar_rows {
        let overlap = (day.start + DAY).min(until) - day.start.max(since);
        if overlap > 0 {
            let weight = overlap as f64 / DAY as f64;
            claude_cost += claude * weight;
            codex_cost += codex * weight;
        }
    }
    let claude = CLAUDE_MIX.totals(claude_cost * scale);
    let codex = CODEX_MIX.totals(codex_cost * scale);
    let mut models = Vec::new();
    for (model, share) in [("claude-opus-4-5", 0.55), ("claude-sonnet-4-5", 0.35), ("claude-haiku-4-5", 0.10)] {
        models.push(model_usage(Provider::Claude, model, share, &claude, true));
    }
    for (model, share, priced) in [("gpt-5-codex", 0.77, true), ("gpt-5", 0.20, true), ("gpt-5.5-preview", 0.03, false)] {
        models.push(model_usage(Provider::Codex, model, share, &codex, priced));
    }
    let provider_totals = |provider: Provider| {
        models.iter().filter(|model| model.provider == provider).fold(Totals::default(), |sum, model| sum.plus(&model.totals))
    };
    let (claude_totals, codex_totals) = (provider_totals(Provider::Claude), provider_totals(Provider::Codex));
    let totals = claude_totals.plus(&codex_totals);
    let mut providers = Vec::new();
    if claude_totals.cost_usd > 0.0 {
        providers.push((Provider::Claude, claude_totals));
    }
    if codex_totals.cost_usd > 0.0 {
        providers.push((Provider::Codex, codex_totals));
    }
    models.retain(|model| token_total(&model.totals) > 0.0);
    models.sort_by(|a, b| token_total(&b.totals).total_cmp(&token_total(&a.totals)));

    let mut projects: Vec<ProjectUsage> = if token_total(&totals) > 0.0 {
        PROJECTS
            .iter()
            .map(|spec| {
                let split: Split = vec![
                    (Provider::Claude, split_point(&claude_totals.scaled(spec.shares.0))),
                    (Provider::Codex, split_point(&codex_totals.scaled(spec.shares.1))),
                ];
                let project_totals = claude_totals.scaled(spec.shares.0).plus(&codex_totals.scaled(spec.shares.1));
                let chats: Vec<ChatUsage> = spec
                    .chats
                    .iter()
                    .enumerate()
                    .map(|(index, (title, kind, share, folder))| ChatUsage {
                        session_id: (*kind == ChatKind::Chat).then_some(100 + index as u32),
                        kind: *kind,
                        title: title.to_string(),
                        detail: (!folder.is_empty()).then(|| folder.to_string()),
                        providers: if index % 3 == 2 { vec![Provider::Codex] } else { vec![Provider::Claude] },
                        totals: project_totals.scaled(share * (1.0 - spec.rest.1)),
                        last_at: NOW - (index as i64 * 7 + 1) * HOUR * if *kind == ChatKind::Archived { 20 } else { 1 },
                    })
                    .collect();
                ProjectUsage {
                    path: spec.path.to_string(),
                    name: spec.name.to_string(),
                    milagre: spec.milagre,
                    totals: project_totals,
                    providers: split,
                    count: spec.chats.len() as u32 + spec.rest.0,
                    chats,
                    more: (spec.rest.0 > 0).then(|| (spec.rest.0, project_totals.scaled(spec.rest.1))),
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    projects.sort_by(|a, b| b.totals.cost_usd.total_cmp(&a.totals.cost_usd));

    Report {
        range,
        days: days.cloned(),
        since,
        until,
        generated_at: NOW,
        refreshing: false,
        first_scan: false,
        pricing: PricingStatus::Ok,
        pricing_fetched_at: Some(NOW - 6 * HOUR),
        totals,
        calendar,
        providers,
        models,
        projects,
        more_projects: None,
    }
}

fn split_point(totals: &Totals) -> SplitPoint {
    SplitPoint { tokens: token_total(totals), cost_usd: totals.cost_usd }
}

/// The days a report names, for tests: the covered keys.
pub fn covered(report: &Report) -> std::collections::HashSet<String> {
    covered_days(&report.calendar, report.since, report.until)
}

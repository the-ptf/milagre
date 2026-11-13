//! The token usage report and its rules, after `packages/shared/src/token-usage.ts` (`TokenUsageReport`, the formats,
//! the calendar). Pure functions and plain types; times are milliseconds since the epoch and day keys are
//! "2026-10-30" in the report's time zone. The test vectors are the ones in `token-usage.test.ts`.

use std::collections::HashSet;

use crate::data::Provider;
use crate::logic::copy::js;
use crate::logic::usage::time::{self, DAY, HOUR};

/// `TokenUsageRange`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Range {
    Day,
    Week,
    Month,
    Quarter,
}

impl Range {
    /// `TOKEN_USAGE_RANGES`, in the order the toolbar lists them.
    pub const ALL: [Range; 4] = [Range::Day, Range::Week, Range::Month, Range::Quarter];

    /// The wire value ("7d").
    pub const fn value(self) -> &'static str {
        match self {
            Range::Day => "24h",
            Range::Week => "7d",
            Range::Month => "30d",
            Range::Quarter => "90d",
        }
    }

    pub fn parse(value: &str) -> Option<Range> {
        Range::ALL.into_iter().find(|range| range.value() == value)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Range::Day => "Past 24 hours",
            Range::Week => "Past 7 days",
            Range::Month => "Past 30 days",
            Range::Quarter => "Past 90 days",
        }
    }

    /// The toolbar's chip text.
    pub const fn short(self) -> &'static str {
        self.value()
    }

    /// The span in days (24 hours is one).
    pub const fn span_days(self) -> i64 {
        match self {
            Range::Day => 1,
            Range::Week => 7,
            Range::Month => 30,
            Range::Quarter => 90,
        }
    }
}

/// `TokenUsageMetric`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Cost,
    Tokens,
}

impl Metric {
    pub const fn value(self) -> &'static str {
        match self {
            Metric::Cost => "cost",
            Metric::Tokens => "tokens",
        }
    }

    pub fn parse(value: &str) -> Metric {
        if value == "tokens" { Metric::Tokens } else { Metric::Cost }
    }
}

/// `TokenUsageDays`: days picked on the calendar, both included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Days {
    pub from: String,
    pub to: String,
}

impl Days {
    pub fn one(key: &str) -> Days {
        Days { from: key.to_string(), to: key.to_string() }
    }

    /// The same span with `from` not after `to` (a drag can run backwards).
    pub fn ordered(self) -> Days {
        if self.from <= self.to { self } else { Days { from: self.to, to: self.from } }
    }

    /// Whether `key` lies in the span, whichever way it was dragged.
    pub fn contains(&self, key: &str) -> bool {
        let (low, high) = if self.from < self.to { (&self.from, &self.to) } else { (&self.to, &self.from) };
        key >= low.as_str() && key <= high.as_str()
    }
}

/// Tokens and cost per provider (`TokenUsageSplit`), in the fixed provider order.
pub type Split = Vec<(Provider, SplitPoint)>;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SplitPoint {
    pub tokens: f64,
    pub cost_usd: f64,
}

/// The cost of each token category (`TokenUsageTotals.cost`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CostSplit {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
}

/// `TokenUsageTotals` (with `TokenCounts`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Totals {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    /// Part of `output`.
    pub reasoning: f64,
    pub requests: f64,
    pub cost_usd: f64,
    pub cost: CostSplit,
    pub cache_savings_usd: f64,
    pub unpriced_tokens: f64,
}

impl Totals {
    /// Every figure times `factor`.
    pub fn scaled(&self, factor: f64) -> Totals {
        Totals {
            input: self.input * factor,
            cache_read: self.cache_read * factor,
            cache_write: self.cache_write * factor,
            output: self.output * factor,
            reasoning: self.reasoning * factor,
            requests: (self.requests * factor).round(),
            cost_usd: self.cost_usd * factor,
            cost: CostSplit {
                input: self.cost.input * factor,
                cache_read: self.cost.cache_read * factor,
                cache_write: self.cost.cache_write * factor,
                output: self.cost.output * factor,
            },
            cache_savings_usd: self.cache_savings_usd * factor,
            unpriced_tokens: self.unpriced_tokens * factor,
        }
    }

    pub fn plus(&self, other: &Totals) -> Totals {
        Totals {
            input: self.input + other.input,
            cache_read: self.cache_read + other.cache_read,
            cache_write: self.cache_write + other.cache_write,
            output: self.output + other.output,
            reasoning: self.reasoning + other.reasoning,
            requests: self.requests + other.requests,
            cost_usd: self.cost_usd + other.cost_usd,
            cost: CostSplit {
                input: self.cost.input + other.cost.input,
                cache_read: self.cost.cache_read + other.cost.cache_read,
                cache_write: self.cost.cache_write + other.cost.cache_write,
                output: self.cost.output + other.cost.output,
            },
            cache_savings_usd: self.cache_savings_usd + other.cache_savings_usd,
            unpriced_tokens: self.unpriced_tokens + other.unpriced_tokens,
        }
    }
}

/// `TokenUsageDay`: one day of the calendar.
#[derive(Clone, Debug, PartialEq)]
pub struct Day {
    pub key: String,
    pub start: i64,
    pub tokens: f64,
    pub cost_usd: f64,
}

/// `TokenUsageChat.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatKind {
    Chat,
    Archived,
    Outside,
    Folder,
}

/// `TokenUsageChat`.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatUsage {
    pub session_id: Option<u32>,
    pub kind: ChatKind,
    pub title: String,
    pub detail: Option<String>,
    pub providers: Vec<Provider>,
    pub totals: Totals,
    pub last_at: i64,
}

/// `TokenUsageProject`.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectUsage {
    /// Empty for Outside Milagre.
    pub path: String,
    pub name: String,
    pub milagre: bool,
    pub totals: Totals,
    pub providers: Split,
    pub count: u32,
    pub chats: Vec<ChatUsage>,
    pub more: Option<(u32, Totals)>,
}

impl ProjectUsage {
    /// The key a row is toggled by.
    pub fn key(&self) -> &str {
        if self.path.is_empty() { "outside" } else { &self.path }
    }
}

/// `TokenUsageModel`.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelUsage {
    pub provider: Provider,
    pub model: String,
    pub priced: bool,
    pub totals: Totals,
}

/// `TokenUsageReport.pricing.status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingStatus {
    Ok,
    Stale,
    Loading,
    Unavailable,
}

/// `TokenUsageReport`, without the hourly `series` the page does not draw.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub range: Range,
    pub days: Option<Days>,
    pub since: i64,
    pub until: i64,
    pub generated_at: i64,
    pub refreshing: bool,
    pub first_scan: bool,
    pub pricing: PricingStatus,
    /// When the price list was fetched, ms.
    pub pricing_fetched_at: Option<i64>,
    pub totals: Totals,
    /// The last 90 days, today last.
    pub calendar: Vec<Day>,
    pub providers: Vec<(Provider, Totals)>,
    pub models: Vec<ModelUsage>,
    pub projects: Vec<ProjectUsage>,
    pub more_projects: Option<(u32, Totals)>,
}

/// The order series stack and legends list.
pub const TOKEN_USAGE_PROVIDERS: [Provider; 2] = [Provider::Claude, Provider::Codex];

/// `TOKEN_USAGE_PROVIDER_COLORS`: mark colours per provider (text never wears them).
pub fn provider_color(provider: Provider) -> Option<gpui::Rgba> {
    match provider {
        Provider::Claude => Some(crate::theme::hex("#D4704F")),
        Provider::Codex => Some(crate::theme::hex("#6A86FF")),
        _ => None,
    }
}

/// `TOKEN_CATEGORIES`, in the order prices list them.
pub const TOKEN_CATEGORIES: [Category; 4] = [Category::Input, Category::CacheRead, Category::CacheWrite, Category::Output];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Input,
    CacheRead,
    CacheWrite,
    Output,
}

impl Category {
    pub const fn label(self) -> &'static str {
        match self {
            Category::Input => "Input",
            Category::CacheRead => "Cache read",
            Category::CacheWrite => "Cache write",
            Category::Output => "Output",
        }
    }

    /// `TOKEN_CATEGORY_INK`: how much ink each category mixes in, in percent (lightest for cache reads).
    pub const fn ink_share(self) -> f64 {
        match self {
            Category::CacheRead => 22.0,
            Category::CacheWrite => 45.0,
            Category::Input => 68.0,
            Category::Output => 90.0,
        }
    }

    pub fn tokens(self, totals: &Totals) -> f64 {
        match self {
            Category::Input => totals.input,
            Category::CacheRead => totals.cache_read,
            Category::CacheWrite => totals.cache_write,
            Category::Output => totals.output,
        }
    }

    pub fn cost(self, totals: &Totals) -> f64 {
        match self {
            Category::Input => totals.cost.input,
            Category::CacheRead => totals.cost.cache_read,
            Category::CacheWrite => totals.cost.cache_write,
            Category::Output => totals.cost.output,
        }
    }
}

/// `tokenTotal`: uncached input, cache reads, cache writes and output.
pub fn token_total(totals: &Totals) -> f64 {
    totals.input + totals.cache_read + totals.cache_write + totals.output
}

/// `cacheHitRate`: cache reads as a share of all input the model read.
pub fn cache_hit_rate(totals: &Totals) -> f64 {
    let read = totals.input + totals.cache_read + totals.cache_write;
    if read > 0.0 { totals.cache_read / read } else { 0.0 }
}

/// `toLocaleString("en-US")` of a whole number: 12,345.
fn grouped(value: f64) -> String {
    let digits = js::number_string(js::round(value));
    let (sign, digits) = digits.strip_prefix('-').map_or(("", digits.as_str()), |rest| ("-", rest));
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{sign}{out}")
}

/// `toFixed(digits)`, rounding half up as the exact decimal does for the values a bill shows.
fn to_fixed(value: f64, digits: u32) -> String {
    let scale = 10f64.powi(digits as i32);
    let scaled = js::round(value * scale);
    if digits == 0 {
        return js::number_string(scaled);
    }
    let whole = (scaled / scale).trunc();
    let fraction = scaled - whole * scale;
    format!("{}.{:0width$}", js::number_string(whole), fraction as i64, width = digits as usize)
}

/// `formatUsd`: $1,234 · $56.70 · $0.42 · <$0.01.
pub fn format_usd(value: f64) -> String {
    if value <= 0.0 {
        "$0".to_string()
    } else if value < 0.01 {
        "<$0.01".to_string()
    } else if value >= 1000.0 {
        format!("${}", grouped(value))
    } else if value >= 100.0 {
        format!("${}", to_fixed(value, 0))
    } else {
        format!("${}", to_fixed(value, 2))
    }
}

/// `formatTokenCount`: 980, 12.4k, 3.1M, 27.9B.
pub fn format_token_count(tokens: f64) -> String {
    let abs = tokens.abs();
    if abs < 1000.0 {
        return js::number_string(js::round(tokens));
    }
    for (size, unit) in [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "k")] {
        if abs >= size {
            let value = tokens / size;
            let shown = if value >= 100.0 { js::round(value) } else { js::round(value * 10.0) / 10.0 };
            return format!("{}{unit}", js::number_string(shown));
        }
    }
    js::number_string(tokens)
}

/// `formatShare`: 0%, <1%, 42%.
pub fn format_share(part: f64, whole: f64) -> String {
    if whole <= 0.0 || part <= 0.0 {
        return "0%".to_string();
    }
    let share = part / whole * 100.0;
    if share < 1.0 { "<1%".to_string() } else { format!("{}%", js::number_string(js::round(share))) }
}

/// `formatMetric`.
pub fn format_metric(metric: Metric, value: f64) -> String {
    match metric {
        Metric::Cost => format_usd(value),
        Metric::Tokens => format_token_count(value),
    }
}

/// `metricOf`.
pub fn metric_of(metric: Metric, totals: &Totals) -> f64 {
    match metric {
        Metric::Cost => totals.cost_usd,
        Metric::Tokens => token_total(totals),
    }
}

/// `splitValue`.
pub fn split_value(metric: Metric, split: &Split, provider: Provider) -> f64 {
    split
        .iter()
        .find(|(candidate, _)| *candidate == provider)
        .map_or(0.0, |(_, point)| if metric == Metric::Cost { point.cost_usd } else { point.tokens })
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// A day key as (year, month, day).
fn parse_key(key: &str) -> Option<(i64, i64, i64)> {
    let mut parts = key.split('-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some((year, month, day))
}

/// Sunday is 0.
fn weekday_of(key: &str) -> usize {
    let (year, month, day) = parse_key(key).unwrap_or((1970, 1, 1));
    (time::days_from_civil(year, month, day) + 4).rem_euclid(7) as usize
}

/// `dayLabel`: "Oct 16", or "Thu, Oct 16" with the weekday.
fn day_label(key: &str, weekday: bool) -> String {
    let (_, month, day) = parse_key(key).unwrap_or((1970, 1, 1));
    let date = format!("{} {day}", MONTHS[(month - 1) as usize]);
    if weekday { format!("{}, {date}", WEEKDAYS[weekday_of(key)]) } else { date }
}

/// `periodLabel`: what the report covers, in words: "Past 7 days", "Thu, Oct 16", "Oct 12 – Oct 18".
pub fn period_label(range: Range, days: Option<&Days>) -> String {
    match days {
        Some(days) if days.from == days.to => day_label(&days.from, true),
        Some(days) => format!("{} \u{2013} {}", day_label(&days.from, false), day_label(&days.to, false)),
        None => range.label().to_string(),
    }
}

/// `coveredDays`: the calendar days the report covers, to draw at full strength.
pub fn covered_days(calendar: &[Day], since: i64, until: i64) -> HashSet<String> {
    let mut covered = HashSet::new();
    for (index, day) in calendar.iter().enumerate() {
        let end = calendar.get(index + 1).map_or(i64::MAX, |next| next.start);
        if day.start < until && end > since {
            covered.insert(day.key.clone());
        }
    }
    covered
}

/// One column of the calendar.
#[derive(Clone, Debug, PartialEq)]
pub struct Week {
    /// The month a column starts, where it changes.
    pub month: Option<&'static str>,
    /// Seven slots, Monday first: an index into the calendar, or none before the first day and after today.
    pub days: [Option<usize>; 7],
}

/// `calendarWeeks`: week columns, Monday first.
pub fn calendar_weeks(calendar: &[Day]) -> Vec<Week> {
    let mut weeks: Vec<Week> = Vec::new();
    let Some(first) = calendar.first() else { return weeks };
    let monday_based = |day: &Day| (weekday_of(&day.key) + 6) % 7;
    let mut column: Vec<Option<usize>> = vec![None; monday_based(first)];
    let flush = |column: &mut Vec<Option<usize>>, weeks: &mut Vec<Week>| {
        let head = column.iter().flatten().next().copied();
        let before = weeks.last().and_then(|week| week.days.iter().flatten().next().copied());
        let month = head.and_then(|head| {
            let changed = before.is_none_or(|before| calendar[head].key[..7] != calendar[before].key[..7]);
            changed.then(|| MONTHS[(parse_key(&calendar[head].key).map_or(1, |(_, m, _)| m) - 1) as usize])
        });
        column.resize(7, None);
        let mut days = [None; 7];
        days.copy_from_slice(&column[..7]);
        weeks.push(Week { month, days });
        column.clear();
    };
    for index in 0..calendar.len() {
        column.push(Some(index));
        if column.len() == 7 {
            flush(&mut column, &mut weeks);
        }
    }
    if !column.is_empty() {
        flush(&mut column, &mut weeks);
    }
    weeks
}

fn day_value(day: &Day, metric: Metric) -> f64 {
    if metric == Metric::Cost { day.cost_usd } else { day.tokens }
}

/// `calendarLevels`: each day's shade, 0 (nothing) to 5, from the fifths of the busy days, so one huge day does not
/// wash out the rest.
pub fn calendar_levels(calendar: &[Day], metric: Metric) -> Vec<u8> {
    let mut busy: Vec<f64> = calendar.iter().map(|day| day_value(day, metric)).filter(|value| *value > 0.0).collect();
    busy.sort_by(|a, b| a.total_cmp(b));
    let cuts: Vec<f64> = [0.2, 0.4, 0.6, 0.8]
        .iter()
        .map(|quantile| if busy.is_empty() { 0.0 } else { busy[(busy.len() - 1).min((quantile * busy.len() as f64).floor() as usize)] })
        .collect();
    calendar
        .iter()
        .map(|day| {
            let value = day_value(day, metric);
            if value <= 0.0 { 0 } else { 1 + cuts.iter().filter(|cut| value > **cut).count() as u8 }
        })
        .collect()
}

/// `calendarSummary`.
#[derive(Clone, Debug, PartialEq)]
pub struct CalendarSummary {
    pub total: f64,
    pub active: usize,
    /// The busiest day's label ("Oct 7") and value.
    pub busiest: Option<(String, f64)>,
}

pub fn calendar_summary(calendar: &[Day], metric: Metric) -> CalendarSummary {
    let (mut total, mut active) = (0.0, 0);
    let mut busiest: Option<&Day> = None;
    for day in calendar {
        let value = day_value(day, metric);
        total += value;
        if value > 0.0 {
            active += 1;
        }
        if busiest.is_none_or(|best| value > day_value(best, metric)) {
            busiest = Some(day);
        }
    }
    let busiest = busiest.filter(|day| day_value(day, metric) > 0.0).map(|day| (day_label(&day.key, false), day_value(day, metric)));
    CalendarSummary { total, active, busiest }
}

/// `calendarDayLabel`: "Thu, Oct 16".
pub fn calendar_day_label(day: &Day) -> String {
    day_label(&day.key, true)
}

/// `chatMeta`: a row's second line: "Archived · 4 d ago", "Outside Milagre · Today", "~/Code/tools".
pub fn chat_meta(chat: &ChatUsage, now: i64) -> String {
    if chat.kind == ChatKind::Folder {
        return chat.detail.clone().unwrap_or_default();
    }
    let elapsed = now - chat.last_at;
    let when = if elapsed < 24 * HOUR { "Today".to_string() } else { format!("{} d ago", elapsed / DAY) };
    match chat.kind {
        ChatKind::Archived => format!("Archived \u{b7} {when}"),
        ChatKind::Outside => format!("Outside Milagre \u{b7} {when}"),
        _ => when,
    }
}

/// `ago` from `main-sync.ts`: "just now", "5 min ago", "3 h ago", "2 d ago".
pub fn ago(at: i64, now: i64) -> String {
    let elapsed = now - at;
    if elapsed < time::MINUTE {
        "just now".to_string()
    } else if elapsed < HOUR {
        format!("{} min ago", elapsed / time::MINUTE)
    } else if elapsed < DAY {
        format!("{} h ago", elapsed / HOUR)
    } else {
        format!("{} d ago", elapsed / DAY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `days(from, costs)` of `token-usage.test.ts`.
    fn days(from: &str, costs: &[f64]) -> Vec<Day> {
        let (year, month, day) = parse_key(from).unwrap();
        let first = time::days_from_civil(year, month, day);
        costs
            .iter()
            .enumerate()
            .map(|(index, cost)| {
                let at = first + index as i64;
                let (y, m, d) = time::civil_from_days(at);
                Day { key: format!("{y:04}-{m:02}-{d:02}"), start: at * DAY, cost_usd: *cost, tokens: cost * 1000.0 }
            })
            .collect()
    }

    fn keys(week: &Week, calendar: &[Day]) -> Vec<Option<String>> {
        week.days.iter().map(|slot| slot.map(|index| calendar[index].key.clone())).collect()
    }

    fn some(texts: [Option<&str>; 7]) -> Vec<Option<String>> {
        texts.iter().map(|text| text.map(str::to_string)).collect()
    }

    #[test]
    fn the_calendar_starts_its_weeks_on_monday_and_names_a_month_where_a_column_starts_it() {
        // 2026-10-30 is a Friday; ten days back is Wednesday 2026-10-21.
        let calendar = days("2026-10-21", &[1.0; 10]);
        let weeks = calendar_weeks(&calendar);
        assert_eq!(weeks.len(), 2);
        assert_eq!(
            keys(&weeks[0], &calendar),
            some([None, None, Some("2026-10-21"), Some("2026-10-22"), Some("2026-10-23"), Some("2026-10-24"), Some("2026-10-25")])
        );
        assert_eq!(
            keys(&weeks[1], &calendar),
            some([Some("2026-10-26"), Some("2026-10-27"), Some("2026-10-28"), Some("2026-10-29"), Some("2026-10-30"), None, None])
        );
        assert_eq!(weeks[0].month, Some("Oct"));
        assert_eq!(weeks[1].month, None);
    }

    #[test]
    fn shades_come_from_the_fifths_of_the_busy_days_so_one_huge_day_does_not_wash_the_rest_out() {
        let calendar = days("2026-10-01", &[0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 5000.0]);
        assert_eq!(calendar_levels(&calendar, Metric::Cost), vec![0, 1, 1, 2, 3, 4, 5]);
        assert_eq!(
            calendar_summary(&calendar, Metric::Cost),
            CalendarSummary { total: 5150.0, active: 6, busiest: Some(("Oct 7".to_string(), 5000.0)) }
        );
        assert_eq!(calendar_levels(&days("2026-10-01", &[0.0, 0.0]), Metric::Cost), vec![0, 0]);
        assert_eq!(calendar_summary(&days("2026-10-01", &[0.0]), Metric::Tokens).busiest, None);
    }

    #[test]
    fn the_days_a_report_covers_and_its_period_in_words() {
        let calendar = days("2026-10-28", &[1.0, 1.0, 1.0]);
        let since = time::days_from_civil(2026, 10, 29) * DAY + 12 * HOUR; // 2026-10-29T12:00:00Z
        let mut covered: Vec<String> = covered_days(&calendar, since, since + DAY).into_iter().collect();
        covered.sort();
        assert_eq!(covered, vec!["2026-10-29", "2026-10-30"]);
        assert_eq!(period_label(Range::Week, None), "Past 7 days");
        assert_eq!(period_label(Range::Week, Some(&Days::one("2026-10-16"))), "Fri, Oct 16");
        assert_eq!(period_label(Range::Week, Some(&Days { from: "2026-10-12".into(), to: "2026-10-18".into() })), "Oct 12 \u{2013} Oct 18");
    }

    #[test]
    fn money_and_counts_read_like_the_typescript() {
        assert_eq!(format_usd(0.0), "$0");
        assert_eq!(format_usd(0.004), "<$0.01");
        assert_eq!(format_usd(0.42), "$0.42");
        assert_eq!(format_usd(56.7), "$56.70");
        assert_eq!(format_usd(100.5), "$101");
        assert_eq!(format_usd(1234.4), "$1,234");
        assert_eq!(format_usd(1_234_567.0), "$1,234,567");
        assert_eq!(format_token_count(980.0), "980");
        assert_eq!(format_token_count(12_400.0), "12.4k");
        assert_eq!(format_token_count(3_100_000.0), "3.1M");
        assert_eq!(format_token_count(27_900_000_000.0), "27.9B");
        assert_eq!(format_token_count(150_000.0), "150k");
        assert_eq!(format_share(0.0, 10.0), "0%");
        assert_eq!(format_share(0.05, 10.0), "<1%");
        assert_eq!(format_share(4.0, 10.0), "40%");
    }

    #[test]
    fn a_chats_second_line_names_where_it_ran_and_when() {
        let chat = |kind, last_at| ChatUsage {
            session_id: None,
            kind,
            title: "t".into(),
            detail: Some("~/Code/tools".into()),
            providers: vec![],
            totals: Totals::default(),
            last_at,
        };
        let now = 10 * DAY;
        assert_eq!(chat_meta(&chat(ChatKind::Chat, now - HOUR), now), "Today");
        assert_eq!(chat_meta(&chat(ChatKind::Archived, now - 4 * DAY), now), "Archived \u{b7} 4 d ago");
        assert_eq!(chat_meta(&chat(ChatKind::Outside, now - HOUR), now), "Outside Milagre \u{b7} Today");
        assert_eq!(chat_meta(&chat(ChatKind::Folder, 0), now), "~/Code/tools");
    }

    #[test]
    fn cache_and_totals_and_a_drag_in_either_direction() {
        let totals = Totals { input: 10.0, cache_read: 80.0, cache_write: 10.0, output: 20.0, ..Totals::default() };
        assert_eq!(token_total(&totals), 120.0);
        assert!((cache_hit_rate(&totals) - 0.8).abs() < 1e-9);
        assert_eq!(cache_hit_rate(&Totals::default()), 0.0);
        let drag = Days { from: "2026-10-18".into(), to: "2026-10-12".into() };
        assert!(drag.contains("2026-10-15") && !drag.contains("2026-10-19"));
        assert_eq!(drag.ordered(), Days { from: "2026-10-12".into(), to: "2026-10-18".into() });
        assert_eq!(ago(0, 90 * time::MINUTE), "1 h ago");
        assert_eq!(Range::parse("30d"), Some(Range::Month));
    }
}

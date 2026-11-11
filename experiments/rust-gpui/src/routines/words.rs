//! The words and rules around Routines: `packages/shared/src/routines.mjs` (trigger and schedule text, the Runs list's
//! folds and days, filters, durations, the Run Chat meta) and `apps/desktop/app/src/lib/routines.ts` (a row's meta and
//! status, the groups, the delete question). Times go through a [`Zone`] the caller supplies; the app's fixture uses
//! [`ZONE`] (UTC), tests pass fixed offsets.

use super::model::{DAY_MS, Fallback, HOUR_MS, LinearEvent, MINUTE_MS, Routine, Run, RunStatus, Target, Trigger, Workspace, model_name};
use crate::data::Millis;
use crate::logic::usage::time::{FixedZone, LocalTime, Zone, local_time};

/// The zone the fixture reads in: UTC, so snapshots do not depend on the Mac running them.
pub const ZONE: FixedZone = FixedZone(0);

const DAYS: [&str; 7] = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAYS_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "HH:MM" on a 24 hour clock (`clock`).
pub fn clock(at: Millis, zone: &dyn Zone) -> String {
    local_time(at, zone).time_24h()
}

/// The zone's midnight that starts the day `at` falls on.
fn midnight(at: Millis, zone: &dyn Zone) -> Millis {
    let offset = i64::from(zone.offset_minutes(at)) * MINUTE_MS;
    (at + offset).div_euclid(DAY_MS) * DAY_MS - offset
}

/// Whole calendar days from `at` to `now`, rounded (a day that DST shortens is still one day).
fn days_between(at: Millis, now: Millis, zone: &dyn Zone) -> i64 {
    let diff = midnight(now, zone) - midnight(at, zone);
    (diff as f64 / DAY_MS as f64).round() as i64
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or(String::new(), |first| first.to_uppercase().chain(chars).collect())
}

fn is_number(text: &str) -> bool {
    !text.is_empty() && text.len() <= 2 && text.bytes().all(|b| b.is_ascii_digit())
}

/// `*/N` with N a positive integer.
fn step_of(field: &str) -> Option<u32> {
    let n = field.strip_prefix("*/")?;
    if n.is_empty() || n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// "08:30" for a cron's minute and hour fields when both are plain numbers on a clock.
fn cron_time(minute: &str, hour: &str) -> Option<String> {
    if !is_number(minute) || !is_number(hour) {
        return None;
    }
    let (m, h): (u32, u32) = (minute.parse().ok()?, hour.parse().ok()?);
    (m <= 59 && h <= 23).then(|| format!("{h:02}:{m:02}"))
}

/// The five fields of a cron expression, when it has exactly five.
fn fields(expression: &str) -> Option<[&str; 5]> {
    let parts: Vec<&str> = expression.split_whitespace().collect();
    <[&str; 5]>::try_from(parts).ok()
}

/// A list of numbers ("0,30") as its step when evenly spaced around `cycle`: (step, first).
fn even_step(list: &str, cycle: u32) -> Option<(u32, u32)> {
    let values: Vec<u32> = list.split(',').map(|v| v.parse().ok()).collect::<Option<_>>()?;
    let step = values.get(1)?.checked_sub(*values.first()?)?;
    if step == 0 || !cycle.is_multiple_of(step) || values.len() as u32 != cycle / step {
        return None;
    }
    values.iter().enumerate().all(|(i, v)| *v == values[0] + i as u32 * step && *v < cycle).then_some((step, values[0]))
}

fn is_list(text: &str, max_digits: usize) -> bool {
    let parts: Vec<&str> = text.split(',').collect();
    parts.len() > 1 && parts.iter().all(|p| !p.is_empty() && p.len() <= max_digits && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The other shapes people write by hand, in words (`cronWords`). `None` stays a cron expression.
fn cron_words([minute, hour, day_of_month, month, day_of_week]: [&str; 5]) -> Option<String> {
    let every_day = day_of_month == "*" && month == "*" && day_of_week == "*";
    if every_day && hour == "*" && is_list(minute, 2) {
        let (step, first) = even_step(minute, 60)?;
        return Some(if first == 0 { format!("every {step} min") } else { format!("every {step} min from :{first:02}") });
    }
    if every_day && is_number(minute) && is_list(hour, 2) {
        let (step, first) = even_step(hour, 24)?;
        let time = cron_time(minute, &first.to_string())?;
        return Some(format!("every {step} h from {time}"));
    }
    let time = cron_time(minute, hour)?;
    if day_of_month == "*"
        && month == "*"
        && !day_of_week.is_empty()
        && day_of_week.split(',').all(|d| d.len() == 1 && matches!(d.as_bytes()[0], b'0'..=b'7'))
    {
        // Monday first, as the Routine form's day picker; 7 is Sunday too.
        let mut days: Vec<usize> = day_of_week.split(',').map(|d| d.parse::<usize>().unwrap_or(0) % 7).collect();
        days.sort_by_key(|d| (d + 6) % 7);
        days.dedup();
        return Some(match days.as_slice() {
            [one] => format!("{} {time}", DAYS[*one]),
            [6, 0] => format!("weekends {time}"),
            many => format!("{} {time}", many.iter().map(|d| DAYS_SHORT[*d]).collect::<Vec<_>>().join(", ")),
        });
    }
    if is_number(day_of_month) && is_number(month) && day_of_week == "*" {
        let m: usize = month.parse().ok()?;
        if (1..=12).contains(&m) {
            return Some(format!("{} {} {time}", MONTHS_SHORT[m - 1], day_of_month.parse::<u32>().ok()?));
        }
    }
    None
}

/// A schedule in words (`scheduleText`), else the cron itself.
fn schedule_text(cron: &str) -> String {
    let expression = cron.trim();
    if let Some([minute, hour, day_of_month, month, day_of_week]) = fields(expression) {
        if day_of_month == "*" && month == "*" {
            if hour == "*"
                && day_of_week == "*"
                && let Some(n) = step_of(minute).filter(|n| *n <= 59)
            {
                return format!("every {n} min");
            }
            if minute == "0"
                && day_of_week == "*"
                && let Some(n) = step_of(hour).filter(|n| *n <= 23)
            {
                return format!("every {n} h");
            }
            if let Some(time) = cron_time(minute, hour) {
                if day_of_week == "1-5" {
                    return format!("weekdays {time}");
                }
                if day_of_week == "*" {
                    return format!("daily {time}");
                }
            }
        }
        if let Some(words) = cron_words([minute, hour, day_of_month, month, day_of_week]) {
            return words;
        }
    }
    format!("cron \"{expression}\"")
}

fn linear_text(event: LinearEvent, team: Option<&str>, label: Option<&str>, state: Option<&str>) -> String {
    let suffix = team.map_or(String::new(), |t| format!(" \u{b7} team {t}"));
    match event {
        LinearEvent::LabelAdded => format!("Linear \u{b7} label {}added{suffix}", label.map_or(String::new(), |l| format!("{l} "))),
        LinearEvent::Assigned => format!("Linear \u{b7} assigned to me{suffix}"),
        LinearEvent::State => format!("Linear \u{b7} moved{}{suffix}", state.map_or(String::new(), |s| format!(" to {s}"))),
        LinearEvent::Comment => format!("Linear \u{b7} new comment{suffix}"),
    }
}

/// What starts a Routine, in a few words (`triggerText`): "every 15 min", "weekdays 08:30", "Linear \u{b7} assigned to me".
pub fn trigger_text(trigger: &Trigger) -> String {
    match trigger {
        Trigger::Schedule { cron, .. } => schedule_text(cron),
        Trigger::Linear { event, team, label, state, .. } => linear_text(*event, team.as_deref(), label.as_deref(), state.as_deref()),
        Trigger::Webhook { .. } => "Webhook".into(),
        Trigger::PullRequest { number } => format!("PR #{number}"),
    }
}

/// Whether Run now works: a schedule or a Heartbeat has nothing to wait for (`canRunNow`).
pub fn can_run_now(routine: &Routine) -> bool {
    if matches!(routine.trigger, Trigger::PullRequest { .. }) {
        return false;
    }
    matches!(routine.target, Target::Chat { .. }) || matches!(routine.trigger, Trigger::Schedule { .. })
}

/// Whether the form can edit it: not a babysit Heartbeat (`canEditRoutine`).
pub fn can_edit(routine: &Routine) -> bool {
    !matches!(routine.trigger, Trigger::PullRequest { .. })
}

/// A heartbeat checks back on one Chat; every other Routine starts a new Chat per Run.
pub fn is_heartbeat(routine: &Routine) -> bool {
    matches!(routine.target, Target::Chat { .. })
}

/// A Run folds into a stretch on the Runs list when it did nothing (or was refused before it ran).
fn is_folded(run: &Run) -> bool {
    run.rejected || matches!(run.status, RunStatus::Quiet | RunStatus::SkippedBusy | RunStatus::Missed)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FoldCounts {
    pub quiet: u32,
    pub skipped: u32,
    pub missed: u32,
    pub refused: u32,
}

/// One stretch of consecutive Runs that did nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct Fold {
    pub runs: Vec<Run>,
    pub counts: FoldCounts,
    /// The newest start in it.
    pub last: Millis,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RunEntry {
    Run(Box<Run>),
    Fold(Fold),
}

/// The Runs list's entries, newest first (`foldRuns`).
pub fn fold_runs(runs: &[Run]) -> Vec<RunEntry> {
    let mut entries: Vec<RunEntry> = Vec::new();
    let mut open = false;
    for run in runs {
        if !is_folded(run) {
            open = false;
            entries.push(RunEntry::Run(Box::new(run.clone())));
            continue;
        }
        if !open {
            entries.push(RunEntry::Fold(Fold { runs: Vec::new(), counts: FoldCounts::default(), last: run.started_at }));
            open = true;
        }
        let Some(RunEntry::Fold(fold)) = entries.last_mut() else { continue };
        fold.runs.push(run.clone());
        fold.last = fold.last.max(run.started_at);
        if run.rejected {
            fold.counts.refused += 1;
        } else if run.status == RunStatus::Quiet {
            fold.counts.quiet += 1;
        } else if run.status == RunStatus::SkippedBusy {
            fold.counts.skipped += 1;
        } else {
            fold.counts.missed += 1;
        }
    }
    entries
}

/// A Run's start as the Runs list says it (`runWhen`): "Today 10:15", "Yesterday 09:00", "Oct 16 09:00".
pub fn run_when(at: Millis, now: Millis, zone: &dyn Zone) -> String {
    let time = clock(at, zone);
    let days = days_between(at, now, zone);
    if days <= 0 {
        return format!("Today {time}");
    }
    if days == 1 {
        return format!("Yesterday {time}");
    }
    let (then, current) = (local_time(at, zone), local_time(now, zone));
    let year = if then.year == current.year { String::new() } else { format!(", {}", then.year) };
    format!("{} {}{year} {time}", MONTHS_SHORT[then.month as usize - 1], then.day)
}

/// When a Routine's next Run is (`nextRunWhen`): (`today`, "16:00" | "Fri 16:00" | "Nov 18 10:00").
pub fn next_run_when(at: Millis, now: Millis, zone: &dyn Zone) -> (bool, String) {
    let time = clock(at, zone);
    let days = days_between(now, at, zone);
    if days <= 0 {
        return (true, time);
    }
    let date = local_time(at, zone);
    if days < 7 {
        return (false, format!("{} {time}", DAYS_SHORT[date.weekday as usize]));
    }
    (false, format!("{} {} {time}", MONTHS_SHORT[date.month as usize - 1], date.day))
}

fn count(n: u32, word: &str) -> String {
    format!("{n} {word}")
}

/// A fold as one line (`foldText`): "4 quiet \u{b7} no TODOs in NOTES.md", "1 skipped, its Chat was busy".
pub fn fold_text(fold: &Fold) -> String {
    let FoldCounts { quiet, skipped, missed, refused } = fold.counts;
    let mut others = Vec::new();
    if skipped > 0 {
        others.push(format!("{}, its Chat was busy", count(skipped, "skipped")));
    }
    if missed > 0 {
        others.push(count(missed, "missed"));
    }
    if refused > 0 {
        others.push(count(refused, "refused"));
    }
    if quiet == 0 {
        return others.join(" \u{b7} ");
    }
    let mut parts = vec![count(quiet, "quiet")];
    if !others.is_empty() {
        parts.extend(others);
    } else if let Some(summary) = fold
        .runs
        .iter()
        .find(|run| run.status == RunStatus::Quiet && !run.rejected && run.summary.as_deref().is_some_and(|s| !s.trim().is_empty()))
        .and_then(|run| run.summary.as_deref())
    {
        parts.push(summary.trim().to_string());
    }
    parts.join(" \u{b7} ")
}

/// A fold's times (`foldTimes`): "06:00\u{2013}09:00", or one time for one Run.
pub fn fold_times(fold: &Fold, zone: &dyn Zone) -> String {
    let starts = fold.runs.iter().map(|run| run.started_at);
    let first = clock(starts.clone().min().unwrap_or(0), zone);
    let last = clock(starts.max().unwrap_or(0), zone);
    if first == last { last } else { format!("{first}\u{2013}{last}") }
}

/// A day's heading (`dayLabel`): "Today", "Yesterday", "Thu, Oct 16", "Tue, Dec 30, 2025".
pub fn day_label(at: Millis, now: Millis, zone: &dyn Zone) -> String {
    let days = days_between(at, now, zone);
    if days <= 0 {
        return "Today".into();
    }
    if days == 1 {
        return "Yesterday".into();
    }
    let (then, current): (LocalTime, LocalTime) = (local_time(at, zone), local_time(now, zone));
    let year = if then.year == current.year { String::new() } else { format!(", {}", then.year) };
    format!("{}, {} {}{year}", then.weekday_short(), MONTHS_SHORT[then.month as usize - 1], then.day)
}

/// One day of Runs (`runDays`).
#[derive(Clone, Debug, PartialEq)]
pub struct RunDay {
    pub key: String,
    pub label: String,
    pub runs: Vec<Run>,
    pub entries: Vec<RunEntry>,
    /// Today and yesterday show their Runs; an older day shows one summary line until opened.
    pub recent: bool,
}

/// The Runs (newest first) by day, newest day first.
pub fn run_days(runs: &[Run], now: Millis, zone: &dyn Zone) -> Vec<RunDay> {
    let mut days: Vec<(String, Millis, Vec<Run>)> = Vec::new();
    for run in runs {
        let local = local_time(run.started_at, zone);
        let key = format!("{}-{}-{}", local.year, local.month, local.day);
        match days.last_mut() {
            Some((last, _, list)) if *last == key => list.push(run.clone()),
            _ => days.push((key, midnight(run.started_at, zone), vec![run.clone()])),
        }
    }
    days.into_iter()
        .map(|(key, at, runs)| RunDay {
            label: day_label(at, now, zone),
            entries: fold_runs(&runs),
            recent: days_between(at, now, zone) <= 1,
            key,
            runs,
        })
        .collect()
}

/// A day's Runs as one line (`daySummary`): "2 acted \u{b7} 12 quiet \u{b7} 1 missed".
pub fn day_summary(runs: &[Run]) -> String {
    let (mut acted, mut failed, mut running, mut quiet, mut skipped, mut missed, mut refused) = (0, 0, 0, 0, 0, 0, 0);
    for run in runs {
        if run.rejected {
            refused += 1;
            continue;
        }
        match run.status {
            RunStatus::Acted => acted += 1,
            RunStatus::Failed => failed += 1,
            RunStatus::Running => running += 1,
            RunStatus::Quiet => quiet += 1,
            RunStatus::SkippedBusy => skipped += 1,
            RunStatus::Missed => missed += 1,
            RunStatus::Ended => {}
        }
    }
    [
        ("acted", acted),
        ("failed", failed),
        ("running", running),
        ("quiet", quiet),
        ("skipped", skipped),
        ("missed", missed),
        ("refused", refused),
    ]
    .into_iter()
    .filter(|(_, n)| *n > 0)
    .map(|(word, n)| count(n, word))
    .collect::<Vec<_>>()
    .join(" \u{b7} ")
}

/// What the Runs filter shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RunFilter {
    All,
    Acted,
    Failed,
    Unread,
}

impl RunFilter {
    pub fn id(self) -> &'static str {
        match self {
            RunFilter::All => "all",
            RunFilter::Acted => "acted",
            RunFilter::Failed => "failed",
            RunFilter::Unread => "unread",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            RunFilter::All => "All",
            RunFilter::Acted => "Acted",
            RunFilter::Failed => "Failed",
            RunFilter::Unread => "Unread",
        }
    }

    pub fn from_id(id: &str) -> RunFilter {
        [RunFilter::Acted, RunFilter::Failed, RunFilter::Unread].into_iter().find(|f| f.id() == id).unwrap_or(RunFilter::All)
    }
}

/// The Runs a filter keeps; `unread` says whether a Run's Chat has a result nobody opened (`filterRuns`).
pub fn filter_runs(runs: &[Run], filter: RunFilter, unread: &dyn Fn(&Run) -> bool) -> Vec<Run> {
    runs.iter()
        .filter(|run| match filter {
            RunFilter::All => true,
            RunFilter::Acted => run.status == RunStatus::Acted && !run.rejected,
            RunFilter::Failed => run.status == RunStatus::Failed && !run.rejected,
            RunFilter::Unread => unread(run),
        })
        .cloned()
        .collect()
}

/// How many Runs each filter keeps (`runFilterCounts`).
pub fn run_filter_counts(runs: &[Run], unread: &dyn Fn(&Run) -> bool) -> [(RunFilter, usize); 4] {
    [RunFilter::All, RunFilter::Acted, RunFilter::Failed, RunFilter::Unread].map(|f| (f, filter_runs(runs, f, unread).len()))
}

/// How long a Run took, in its largest units (`runDuration`): "38 s", "4 min", "1 h 5 min".
pub fn run_duration(ms: i64) -> String {
    let seconds = (ms as f64 / 1000.0).round().max(0.0) as i64;
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let minutes = (seconds as f64 / 60.0).round() as i64;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest > 0 { format!("{hours} h {rest} min") } else { format!("{hours} h") }
}

/// The Run Chat pane's line under its title (`runChatMeta`): "Run at 11:47 \u{b7} acted in 38 s \u{b7} main".
pub fn run_chat_meta(run: &Run, branch: Option<&str>, zone: &dyn Zone) -> String {
    let mut parts = vec![format!("Run at {}", clock(run.started_at, zone))];
    match run.status {
        RunStatus::Running => parts.push("running".into()),
        status @ (RunStatus::Acted | RunStatus::Quiet | RunStatus::Failed) => {
            let word = match status {
                RunStatus::Acted => "acted",
                RunStatus::Quiet => "quiet",
                _ => "failed",
            };
            parts.push(match run.ended_at {
                Some(end) => format!("{word} in {}", run_duration(end - run.started_at)),
                None => word.into(),
            });
        }
        _ => {}
    }
    if let Some(branch) = branch {
        parts.push(branch.into());
    }
    parts.join(" \u{b7} ")
}

fn plural(n: u32, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

/// How long until `at`, rounded in the largest unit: "2 days", "5 h", "12 min".
fn until(at: Millis, now: Millis) -> String {
    let left = (at - now).max(0);
    if left >= DAY_MS {
        return plural((left as f64 / DAY_MS as f64).round() as u32, "day");
    }
    if left >= HOUR_MS {
        return format!("{} h", (left as f64 / HOUR_MS as f64).round() as i64);
    }
    format!("{} min", ((left + MINUTE_MS - 1) / MINUTE_MS).max(1))
}

/// When a Routine ends (`routineEnd`): "3 of 20 Runs left", "ends in 2 days"; `None` when it runs until switched off.
pub fn routine_end(routine: &Routine, now: Millis) -> Option<String> {
    if let Some(max) = routine.max_runs {
        return Some(format!("{} of {} left", max.saturating_sub(routine.run_count), plural(max, "Run")));
    }
    routine.expires_at.map(|at| format!("ends in {}", until(at, now)))
}

/// The Routine page's line under its chips (`routineTimes`).
pub fn routine_times(routine: &Routine, now: Millis, zone: &dyn Zone) -> String {
    let mut parts = Vec::new();
    if let (true, Some(next)) = (routine.enabled, routine.next_run_at) {
        parts.push(format!("Next Run {}", clock(next, zone)));
    }
    let last = if routine.runs.is_empty() { routine.last_run_at } else { routine.runs.iter().map(|run| run.started_at).max() };
    if let Some(last) = last {
        let when = run_when(last, now, zone);
        let when = match when.strip_prefix("Today ") {
            Some(rest) => rest.to_string(),
            None => {
                let mut chars = when.chars();
                chars.next().map_or(String::new(), |c| c.to_lowercase().chain(chars).collect())
            }
        };
        parts.push(format!("last Run {when}"));
    }
    if let Some(end) = routine_end(routine, now) {
        parts.push(end);
    }
    capitalized(&parts.join(" \u{b7} "))
}

/// A schedule as its chip says it (`scheduleWords`): "Every 15 min", "Daily at 08:30", "Mon, Wed at 08:30", "Cron ...".
pub fn schedule_words(cron: &str) -> String {
    let expression = cron.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some([minute, hour, day_of_month, month, day_of_week]) = fields(&expression)
        && day_of_month == "*"
        && month == "*"
    {
        if hour == "*"
            && day_of_week == "*"
            && let Some(n) = step_of(minute).filter(|n| *n <= 59)
        {
            return format!("Every {n} min");
        }
        if minute == "0"
            && day_of_week == "*"
            && let Some(n) = step_of(hour).filter(|n| *n <= 23)
        {
            return if n == 1 { "Every hour".into() } else { format!("Every {n} hours") };
        }
        if minute == "0" && hour == "*" && day_of_week == "*" {
            return "Every hour".into();
        }
        if let Some(time) = cron_time(minute, hour) {
            if day_of_week == "*" {
                return format!("Daily at {time}");
            }
            if day_of_week == "1-5" {
                return format!("Weekdays at {time}");
            }
            if !day_of_week.is_empty() && day_of_week.split(',').all(|d| d.len() == 1 && matches!(d.as_bytes()[0], b'0'..=b'6')) {
                let mut days: Vec<usize> = day_of_week.split(',').map(|d| d.parse().unwrap_or(0)).collect();
                days.sort_unstable();
                days.dedup();
                if days.len() == 7 {
                    return format!("Daily at {time}");
                }
                return format!("{} at {time}", days.iter().map(|d| DAYS_SHORT[*d]).collect::<Vec<_>>().join(", "));
            }
        }
    }
    if expression.is_empty() { "No schedule".into() } else { format!("Cron {expression}") }
}

/// A time zone as a place (`zonePlace`): "America/Sao_Paulo" is "Sao Paulo".
pub fn zone_place(zone: &str) -> String {
    zone.rsplit('/').next().unwrap_or(zone).replace('_', " ")
}

/// What starts a Routine, as its chip says it (`triggerChipText`). A schedule in another zone than `local_zone` names it.
pub fn trigger_chip_text(trigger: &Trigger, local_zone: Option<&str>) -> String {
    if let Trigger::Schedule { cron, timezone } = trigger {
        let words = schedule_words(cron);
        return match local_zone {
            Some(local) if !timezone.is_empty() && timezone != local && !words.starts_with("Every ") => {
                format!("{words} ({})", zone_place(timezone))
            }
            _ => words,
        };
    }
    capitalized(&trigger_text(trigger))
}

fn last_segment(path: &str) -> &str {
    path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(path)
}

/// Where a Routine's Runs land, as its chip says it (`routineWhereText`).
pub fn routine_where_text(target: &Target, chat_title: &dyn Fn(&str) -> Option<String>) -> String {
    match target {
        Target::Chat { chat_id } => format!("In {}", chat_title(chat_id).filter(|t| !t.is_empty()).unwrap_or_else(|| "a Chat".into())),
        Target::NewChat { project_path, workspace } => {
            format!("New {} in {}", if *workspace == Workspace::Worktree { "Worktree" } else { "Chat" }, last_segment(project_path))
        }
    }
}

/// A Run's name on the Runs list (`runTitle`).
pub fn run_title(run: &Run, routine_name: &str) -> String {
    if let Some(title) = run.title.as_deref().filter(|t| !t.trim().is_empty()) {
        return title.to_string();
    }
    match &run.issue {
        Some(issue) => match &issue.title {
            Some(title) if !title.is_empty() => format!("{} {title}", issue.key),
            _ => issue.key.clone(),
        },
        None => routine_name.to_string(),
    }
}

fn first_error_line(text: Option<&str>) -> String {
    text.and_then(|t| t.lines().find(|l| !l.trim().is_empty())).map_or(String::new(), |l| l.trim().to_string())
}

/// The first line of a failed Run's error, as its row shows it.
pub fn first_line(text: Option<&str>) -> Option<String> {
    let line = first_error_line(text);
    (!line.is_empty()).then_some(line)
}

fn model_text(model: Option<&str>, effort: Option<&str>) -> String {
    match model {
        Some(model) => format!("{model}{}", effort.map_or(String::new(), |e| format!(" \u{b7} {e}"))),
        None => "its model".into(),
    }
}

/// Whether a Routine's Runs retry on a fallback: Runs in a Chat of their own do; a beat and a Linear comment don't.
pub fn routine_retries(routine: &Routine) -> bool {
    matches!(routine.target, Target::NewChat { .. }) && !matches!(routine.trigger, Trigger::Linear { event: LinearEvent::Comment, .. })
}

/// What a Routine's Runs retry on (`fallbackText`): "Retry on Opus 5.5 \u{b7} high".
pub fn fallback_text(routine: &Routine) -> String {
    match &routine.fallback {
        None => "Retry on another provider".into(),
        Some(Fallback { provider, model, effort }) => {
            format!(
                "Retry on {}{}",
                model_name(Some(*provider), model),
                effort.as_deref().map_or(String::new(), |e| format!(" \u{b7} {e}"))
            )
        }
    }
}

/// The line of an attempt that failed and was retried (`attemptText`).
pub fn attempt_text(model: Option<&str>, effort: Option<&str>, error: Option<&str>) -> String {
    let error = first_error_line(error);
    format!("First try on {} failed{}", model_text(model, effort), if error.is_empty() { String::new() } else { format!(": {error}") })
}

/// What a Run that ran on its fallback adds to its row (`retryNote`).
pub fn retry_note(run: &Run) -> String {
    run.fallback.as_ref().map_or(String::new(), |f| format!("retried on {}", model_text(f.model.as_deref(), f.effort.as_deref())))
}

/// What the delete confirmation says a delete does (`deleteWarning`).
pub fn delete_warning(routine: &Routine) -> &'static str {
    if is_heartbeat(routine) { "Its Chats stay." } else { "Its Runs stop, and its Run Chats you haven't kept are archived." }
}

pub fn delete_question(routine: &Routine) -> String {
    format!("Delete {}? {}", routine.name, delete_warning(routine))
}

/// The groups of the list page. Paused Routines stay in their group too, so the counts overlap.
pub struct Groups<'a> {
    pub heartbeats: Vec<&'a Routine>,
    pub triggers: Vec<&'a Routine>,
    pub paused: Vec<&'a Routine>,
}

pub fn group_routines<'a>(routines: &[&'a Routine]) -> Groups<'a> {
    Groups {
        heartbeats: routines.iter().copied().filter(|r| is_heartbeat(r)).collect(),
        triggers: routines.iter().copied().filter(|r| !is_heartbeat(r)).collect(),
        paused: routines.iter().copied().filter(|r| !r.enabled).collect(),
    }
}

/// How long ago `at` was (`ago`): "just now", "12 min ago", "2 h ago", "yesterday", "3 days ago".
fn ago(at: Millis, now: Millis, zone: &dyn Zone) -> String {
    let past = (now - at).max(0);
    if past < MINUTE_MS {
        return "just now".into();
    }
    if past < HOUR_MS {
        return format!("{} min ago", past / MINUTE_MS);
    }
    let days = days_between(at, now, zone);
    if days <= 0 {
        return format!("{} h ago", past / HOUR_MS);
    }
    if days == 1 { "yesterday".into() } else { format!("{days} days ago") }
}

/// A row's second line (`routineMeta`): what starts it, where it runs, then its end (or its model and mode).
pub fn routine_meta(routine: &Routine, chat_title: &dyn Fn(&str) -> Option<String>, now: Millis) -> String {
    let where_ = match &routine.target {
        Target::Chat { chat_id } => format!("in {}", chat_title(chat_id).unwrap_or_else(|| "a Chat".into())),
        Target::NewChat { project_path, workspace } => {
            format!("new {} in {}", if *workspace == Workspace::Worktree { "Worktree" } else { "Chat" }, last_segment(project_path))
        }
    };
    let last = if is_heartbeat(routine) { routine_end(routine, now) } else { routine_model(routine).or_else(|| routine_end(routine, now)) };
    [Some(capitalized(&trigger_text(&routine.trigger))), Some(where_), last].into_iter().flatten().collect::<Vec<_>>().join(" \u{b7} ")
}

/// The model and mode a Routine's Runs use, "Opus 5.5 \u{b7} Full", or `None` when it uses the Mac's defaults.
fn routine_model(routine: &Routine) -> Option<String> {
    let model = routine.model.as_deref().map(|m| model_name(routine.provider, m));
    let mode = routine
        .permission_mode
        .as_deref()
        .map(|m| crate::logic::copy::model_copy::PermissionMode::from_id(m).map_or(m.to_string(), |mode| mode.label().to_string()));
    let parts: Vec<String> = [model, mode].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.join(" \u{b7} "))
}

/// The row's right-hand text (`routineStatus`): "Paused", "Next 10:45", "Fri 16:00", or its last Run.
pub fn routine_status(routine: &Routine, now: Millis, zone: &dyn Zone) -> String {
    if !routine.enabled {
        return "Paused".into();
    }
    if let (Trigger::Schedule { .. }, Some(next)) = (&routine.trigger, routine.next_run_at) {
        let (today, text) = next_run_when(next, now, zone);
        return if today { format!("Next {text}") } else { text };
    }
    let Some(run) = routine.runs.first() else { return "No Runs yet".into() };
    let when = ago(run.started_at, now, zone);
    if let Some(issue) = &run.issue {
        return format!("{} \u{b7} {when}", issue.key);
    }
    if when == "yesterday" { format!("Yesterday {}", clock(run.started_at, zone)) } else { capitalized(&when) }
}

/// What a problem under a row says: why it paused itself while off, else its latest error (`routineProblem`).
pub fn routine_problem(routine: &Routine) -> Option<&str> {
    match &routine.paused_reason {
        Some(reason) if !routine.enabled => Some(reason),
        _ => routine.last_error.as_deref(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::usage::time::epoch_ms;

    fn schedule(cron: &str) -> Trigger {
        Trigger::Schedule { cron: cron.into(), timezone: "UTC".into() }
    }

    #[test]
    fn trigger_text_reads_the_shapes_the_form_makes() {
        for (cron, text) in [
            ("*/15 * * * *", "every 15 min"),
            ("0 */2 * * *", "every 2 h"),
            ("30 8 * * 1-5", "weekdays 08:30"),
            ("30 8 * * *", "daily 08:30"),
            ("0,30 * * * *", "every 30 min"),
            ("15,45 * * * *", "every 30 min from :15"),
            ("0 2,8,14,20 * * *", "every 6 h from 02:00"),
            ("0 16 * * 5", "Fridays 16:00"),
            ("30 8 * * 6,0", "weekends 08:30"),
            ("0 9 * * 1,3", "Mon, Wed 09:00"),
            ("0 10 11 11 *", "Nov 11 10:00"),
            ("5 4 1 * *", "cron \"5 4 1 * *\""),
        ] {
            assert_eq!(trigger_text(&schedule(cron)), text, "{cron}");
        }
    }

    #[test]
    fn trigger_text_names_the_other_triggers() {
        let linear = |event, team: Option<&str>, label: Option<&str>, state: Option<&str>| Trigger::Linear {
            workspace: "w".into(),
            event,
            team: team.map(Into::into),
            label: label.map(Into::into),
            state: state.map(Into::into),
        };
        assert_eq!(
            trigger_text(&linear(LinearEvent::LabelAdded, Some("MIL"), Some("agent"), None)),
            "Linear \u{b7} label agent added \u{b7} team MIL"
        );
        assert_eq!(trigger_text(&linear(LinearEvent::Assigned, None, None, None)), "Linear \u{b7} assigned to me");
        assert_eq!(trigger_text(&linear(LinearEvent::State, None, None, Some("In Review"))), "Linear \u{b7} moved to In Review");
        assert_eq!(trigger_text(&Trigger::Webhook { hook_id: "h".into(), signed: false }), "Webhook");
        assert_eq!(trigger_text(&Trigger::PullRequest { number: 1013 }), "PR #1013");
    }

    #[test]
    fn schedule_words_and_zone() {
        assert_eq!(schedule_words("*/15 * * * *"), "Every 15 min");
        assert_eq!(schedule_words("0 */1 * * *"), "Every hour");
        assert_eq!(schedule_words("0 */2 * * *"), "Every 2 hours");
        assert_eq!(schedule_words("30 8 * * 1,3"), "Mon, Wed at 08:30");
        assert_eq!(schedule_words("30 8 * * 1-5"), "Weekdays at 08:30");
        assert_eq!(schedule_words("1 2 3 4 5"), "Cron 1 2 3 4 5");
        let sp = Trigger::Schedule { cron: "30 8 * * 1-5".into(), timezone: "America/Sao_Paulo".into() };
        assert_eq!(trigger_chip_text(&sp, Some("UTC")), "Weekdays at 08:30 (Sao Paulo)");
        assert_eq!(trigger_chip_text(&sp, Some("America/Sao_Paulo")), "Weekdays at 08:30");
        assert_eq!(trigger_chip_text(&Trigger::Webhook { hook_id: String::new(), signed: true }, None), "Webhook");
    }

    #[test]
    fn times_read_on_the_zone_clock() {
        let now = epoch_ms(2026, 11, 11, 12, 5, 0);
        let at = |d, h, m| epoch_ms(2026, 11, d, h, m, 0);
        assert_eq!(run_when(at(11, 10, 15), now, &ZONE), "Today 10:15");
        assert_eq!(run_when(at(10, 9, 0), now, &ZONE), "Yesterday 09:00");
        assert_eq!(run_when(at(5, 9, 0), now, &ZONE), "Nov 5 09:00");
        assert_eq!(run_when(epoch_ms(2025, 12, 30, 8, 0, 0), now, &ZONE), "Dec 30, 2025 08:00");
        assert_eq!(next_run_when(at(11, 16, 0), now, &ZONE), (true, "16:00".into()));
        assert_eq!(next_run_when(at(13, 16, 0), now, &ZONE), (false, "Fri 16:00".into()));
        assert_eq!(next_run_when(at(20, 10, 0), now, &ZONE), (false, "Nov 20 10:00".into()));
        // Seen from UTC-3 the same moment is the day before.
        assert_eq!(run_when(epoch_ms(2026, 11, 11, 1, 0, 0), now, &FixedZone(-180)), "Yesterday 22:00");
    }

    fn run(id: &str, at: Millis, status: RunStatus) -> Run {
        Run::new(id, at, status)
    }

    #[test]
    fn quiet_stretches_fold_and_acted_runs_break_them() {
        let runs = vec![
            run("a", 600, RunStatus::Quiet),
            run("b", 500, RunStatus::Quiet),
            run("c", 400, RunStatus::Acted),
            run("d", 300, RunStatus::SkippedBusy),
            Run { rejected: true, ..run("e", 200, RunStatus::Failed) },
        ];
        let entries = fold_runs(&runs);
        assert_eq!(entries.len(), 3);
        let RunEntry::Fold(first) = &entries[0] else { panic!("fold") };
        assert_eq!((first.counts.quiet, first.runs.len(), first.last), (2, 2, 600));
        let RunEntry::Fold(last) = &entries[2] else { panic!("fold") };
        assert_eq!((last.counts.skipped, last.counts.refused), (1, 1));
        assert_eq!(fold_text(last), "1 skipped, its Chat was busy \u{b7} 1 refused");
    }

    #[test]
    fn fold_text_leads_with_the_latest_quiet_summary() {
        let mut quiet = run("a", 0, RunStatus::Quiet);
        quiet.summary = Some("CI green".into());
        let entries = fold_runs(&[quiet.clone(), run("b", 0, RunStatus::Quiet)]);
        let RunEntry::Fold(fold) = &entries[0] else { panic!("fold") };
        assert_eq!(fold_text(fold), "2 quiet \u{b7} CI green");
        assert_eq!(fold_times(fold, &ZONE), "00:00");
    }

    #[test]
    fn days_group_runs_and_old_days_are_summaries() {
        let now = epoch_ms(2026, 11, 11, 12, 5, 0);
        let runs = vec![
            run("a", epoch_ms(2026, 11, 11, 9, 0, 0), RunStatus::Acted),
            run("b", epoch_ms(2026, 11, 10, 23, 0, 0), RunStatus::Quiet),
            run("c", epoch_ms(2026, 11, 7, 9, 0, 0), RunStatus::Quiet),
            run("d", epoch_ms(2026, 11, 7, 8, 0, 0), RunStatus::Missed),
        ];
        let days = run_days(&runs, now, &ZONE);
        assert_eq!(
            days.iter().map(|d| (d.label.as_str(), d.recent)).collect::<Vec<_>>(),
            [("Today", true), ("Yesterday", true), ("Sat, Nov 7", false)]
        );
        assert_eq!(day_summary(&days[2].runs), "1 quiet \u{b7} 1 missed");
    }

    #[test]
    fn filters_count_and_unread_asks_the_caller() {
        let mut failed = run("f", 3, RunStatus::Failed);
        failed.error = Some("boom".into());
        let runs = vec![
            run("a", 4, RunStatus::Acted),
            failed,
            Run { rejected: true, ..run("r", 2, RunStatus::Failed) },
            run("q", 1, RunStatus::Quiet),
        ];
        let unread = |run: &Run| run.id == "q";
        let counts = run_filter_counts(&runs, &unread);
        assert_eq!(counts.map(|(_, n)| n), [4, 1, 1, 1]);
        assert_eq!(filter_runs(&runs, RunFilter::Failed, &unread)[0].id, "f");
    }

    #[test]
    fn durations_and_the_run_chat_meta() {
        assert_eq!(run_duration(38_000), "38 s");
        assert_eq!(run_duration(4 * 60_000), "4 min");
        assert_eq!(run_duration(65 * 60_000), "1 h 5 min");
        assert_eq!(run_duration(2 * 3_600_000), "2 h");
        let mut r = run("a", epoch_ms(2026, 11, 11, 11, 47, 0), RunStatus::Acted);
        r.ended_at = Some(r.started_at + 38_000);
        assert_eq!(run_chat_meta(&r, Some("main"), &ZONE), "Run at 11:47 \u{b7} acted in 38 s \u{b7} main");
        r.status = RunStatus::Running;
        assert_eq!(run_chat_meta(&r, None, &ZONE), "Run at 11:47 \u{b7} running");
    }

    #[test]
    fn routine_end_times_and_status() {
        let now = epoch_ms(2026, 11, 11, 12, 5, 0);
        let mut routine = Routine::new("r", "Triage", schedule("*/10 * * * *"), Target::Chat { chat_id: "c".into() });
        routine.max_runs = Some(20);
        routine.run_count = 17;
        assert_eq!(routine_end(&routine, now).as_deref(), Some("3 of 20 Runs left"));
        routine.max_runs = None;
        routine.expires_at = Some(now + 2 * DAY_MS + 60_000);
        assert_eq!(routine_end(&routine, now).as_deref(), Some("ends in 2 days"));
        routine.next_run_at = Some(epoch_ms(2026, 11, 11, 12, 10, 0));
        assert_eq!(routine_status(&routine, now, &ZONE), "Next 12:10");
        routine.enabled = false;
        assert_eq!(routine_status(&routine, now, &ZONE), "Paused");
        assert_eq!(routine_times(&routine, now, &ZONE), "Ends in 2 days");
    }

    #[test]
    fn meta_names_the_trigger_where_and_model() {
        let now = epoch_ms(2026, 11, 11, 12, 5, 0);
        let mut routine = Routine::new(
            "r",
            "Triage",
            Trigger::Linear { workspace: "w".into(), event: LinearEvent::Assigned, team: None, label: None, state: None },
            Target::NewChat { project_path: "/code/payments-api".into(), workspace: Workspace::Worktree },
        );
        routine.model = Some("claude-opus-5-5".into());
        routine.provider = Some(crate::data::Provider::Claude);
        routine.permission_mode = Some("full".into());
        assert_eq!(
            routine_meta(&routine, &|_| None, now),
            "Linear \u{b7} assigned to me \u{b7} new Worktree in payments-api \u{b7} Opus 5.5 \u{b7} Full"
        );
        assert_eq!(routine_where_text(&routine.target, &|_| None), "New Worktree in payments-api");
        assert_eq!(delete_question(&routine), "Delete Triage? Its Runs stop, and its Run Chats you haven't kept are archived.");
    }

    #[test]
    fn fallback_and_attempts() {
        let mut routine =
            Routine::new("r", "x", schedule("0 * * * *"), Target::NewChat { project_path: "/p".into(), workspace: Workspace::Project });
        assert!(routine_retries(&routine));
        assert_eq!(fallback_text(&routine), "Retry on another provider");
        routine.fallback =
            Some(Fallback { provider: crate::data::Provider::Claude, model: "claude-opus-5-5".into(), effort: Some("high".into()) });
        assert_eq!(fallback_text(&routine), "Retry on Opus 5.5 \u{b7} high");
        assert_eq!(
            attempt_text(Some("gpt-6.1-sol"), None, Some("\nSelected model is at capacity.\nmore")),
            "First try on gpt-6.1-sol failed: Selected model is at capacity."
        );
        let mut r = run("a", 0, RunStatus::Acted);
        r.fallback = Some(RunFallback { model: Some("claude-opus-5-5".into()), effort: Some("high".into()) });
        assert_eq!(retry_note(&r), "retried on claude-opus-5-5 \u{b7} high");
    }

    use super::super::model::RunFallback;

    #[test]
    fn run_now_and_edit_rules() {
        let babysit = Routine::new("b", "Babysit", Trigger::PullRequest { number: 1 }, Target::Chat { chat_id: "c".into() });
        assert!(!can_run_now(&babysit) && !can_edit(&babysit));
        let webhook = Routine::new(
            "w",
            "Hook",
            Trigger::Webhook { hook_id: "h".into(), signed: false },
            Target::NewChat { project_path: "/p".into(), workspace: Workspace::Worktree },
        );
        assert!(!can_run_now(&webhook) && can_edit(&webhook));
    }
}

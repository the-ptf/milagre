//! The Routine form's state and what it saves: `packages/shared/src/routine-form.mjs`. The `routines:create` input for
//! a new Routine, the `routines:update` patch for an edited one, validated the same way the phone does it. The vectors
//! in `routine-form.test.mjs` (cron round trips, the stop rules) are the tests below.

use super::model::{DAY_MS, Fallback, LinearEvent, MINUTE_MS, Routine, Target, Trigger, Workspace};
use crate::data::{Millis, Provider};
use crate::logic::usage::time::{Zone, days_from_civil, local_time};

pub const EVERY_MINUTES: [u32; 11] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
pub const EVERY_HOURS: [u32; 8] = [1, 2, 3, 4, 6, 8, 12, 24];
const MAX_EXPIRY_MS: i64 = 30 * DAY_MS;
const MAX_RUNS_LIMIT: i64 = 1000;
const NAME_MAX: usize = 80;
const PROMPT_MAX: usize = 4000;
const HEARTBEAT_DAYS: i64 = 7;

const CHAT_ONLY_SCHEDULE: &str = "Only schedule triggers can target an existing Chat";
const SIGNED_NEEDS_SECRET: &str = "A signed webhook needs a signing secret";

/// The prompt copy, the same on desktop and the phone.
pub const PROMPT_PLACEHOLDER: &str = "What should the agent do on each Run? End with (pass) when there's nothing to do.";
pub const PROMPT_HINT: &str = "Type {{ for the Run's fields";

/// The hint under the prompt for a trigger (`promptHint`): an event's fields are data, never instructions.
pub fn prompt_hint(trigger: TriggerKind) -> String {
    match trigger {
        TriggerKind::Linear => format!("{PROMPT_HINT}. Issue text is passed as data, not instructions."),
        TriggerKind::Webhook => format!("{PROMPT_HINT}. The request is passed as data, not instructions."),
        TriggerKind::Schedule => PROMPT_HINT.to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriggerKind {
    Schedule,
    Linear,
    Webhook,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleMode {
    Every,
    At,
    Cron,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EveryUnit {
    Min,
    Hour,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleForm {
    pub mode: ScheduleMode,
    pub every: u32,
    pub unit: EveryUnit,
    pub time: String,
    /// 0 is Sunday.
    pub days: Vec<u8>,
    pub cron: String,
    pub timezone: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LinearForm {
    pub workspace: String,
    pub event: LinearEvent,
    pub team: String,
    pub label: String,
    pub state: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WebhookForm {
    pub signed: bool,
    pub signing_header: String,
    pub signing_secret: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunIn {
    Worktree,
    Project,
    Chat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopKind {
    Never,
    Runs,
    Date,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StopForm {
    pub kind: StopKind,
    pub runs: i64,
    pub at: Millis,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoutineForm {
    pub name: String,
    pub trigger: TriggerKind,
    pub schedule: ScheduleForm,
    pub linear: LinearForm,
    pub webhook: WebhookForm,
    pub project_path: String,
    pub run_in: RunIn,
    pub chat_id: String,
    pub provider: Option<Provider>,
    pub model: String,
    pub permission_mode: String,
    pub fallback_provider: Option<Provider>,
    pub fallback_model: String,
    pub fallback_effort: String,
    pub prompt: String,
    pub stop: StopForm,
}

/// The field a validation problem belongs to (`RoutineFormField`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Name,
    Trigger,
    Schedule,
    Timezone,
    Workspace,
    Label,
    State,
    Project,
    RunIn,
    Chat,
    Prompt,
    Stop,
    SigningSecret,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormError {
    pub field: Field,
    pub error: String,
}

fn fail<T>(field: Field, error: impl Into<String>) -> Result<T, FormError> {
    Err(FormError { field, error: error.into() })
}

/// A new Routine's form: a schedule every hour in a new worktree, running until switched off (`emptyRoutineForm`).
pub fn empty_form(timezone: &str, now: Millis) -> RoutineForm {
    RoutineForm {
        name: String::new(),
        trigger: TriggerKind::Schedule,
        schedule: ScheduleForm {
            mode: ScheduleMode::Every,
            every: 1,
            unit: EveryUnit::Hour,
            time: "09:00".into(),
            days: vec![1, 2, 3, 4, 5],
            cron: String::new(),
            timezone: timezone.into(),
        },
        linear: LinearForm {
            workspace: String::new(),
            event: LinearEvent::LabelAdded,
            team: String::new(),
            label: String::new(),
            state: String::new(),
        },
        webhook: WebhookForm::default(),
        project_path: String::new(),
        run_in: RunIn::Worktree,
        chat_id: String::new(),
        provider: None,
        model: String::new(),
        permission_mode: String::new(),
        fallback_provider: None,
        fallback_model: String::new(),
        fallback_effort: String::new(),
        prompt: String::new(),
        stop: StopForm { kind: StopKind::Never, runs: 10, at: now + HEARTBEAT_DAYS * DAY_MS },
    }
}

/// A Linear comment Routine has no Each run: comments go into the Chat linked to the issue (`isCommentRoutine`).
pub fn is_comment(form: &RoutineForm) -> bool {
    form.trigger == TriggerKind::Linear && form.linear.event == LinearEvent::Comment
}

/// Whether a Routine's Runs can retry on a fallback model: only a Run in a Chat of its own does (`fallbackApplies`).
pub fn fallback_applies(form: &RoutineForm) -> bool {
    form.run_in != RunIn::Chat && !is_comment(form)
}

fn fallback_of(form: &RoutineForm) -> Option<Fallback> {
    let provider = form.fallback_provider?;
    let model = form.fallback_model.trim();
    if model.is_empty() {
        return None;
    }
    let effort = form.fallback_effort.trim();
    Some(Fallback { provider, model: model.to_string(), effort: (!effort.is_empty()).then(|| effort.to_string()) })
}

/// The form with Runs landing in `run_in`. A heartbeat can't run forever, so moving to a Chat turns Never into 7 days.
pub fn with_run_in(form: &RoutineForm, run_in: RunIn, now: Millis) -> RoutineForm {
    let mut next = form.clone();
    next.run_in = run_in;
    if run_in == RunIn::Chat && next.stop.kind == StopKind::Never {
        next.stop.kind = StopKind::Date;
        next.stop.at = now + HEARTBEAT_DAYS * DAY_MS;
    }
    next
}

/// The cron a schedule makes, in the shapes `trigger_text` reads back as words, or why it can't (`scheduleCron`).
pub fn schedule_cron(schedule: &ScheduleForm) -> Result<String, String> {
    match schedule.mode {
        ScheduleMode::Cron => {
            let cron = schedule.cron.split_whitespace().collect::<Vec<_>>().join(" ");
            if cron.is_empty() { Err("Give a cron expression".into()) } else { Ok(cron) }
        }
        ScheduleMode::At => {
            let Some((hour, minute)) = parse_time(&schedule.time) else { return Err("Give a time as HH:MM".into()) };
            let mut days: Vec<u8> = schedule.days.iter().copied().filter(|d| *d <= 6).collect();
            days.sort_unstable();
            days.dedup();
            if days.is_empty() {
                return Err("Pick at least one day".into());
            }
            let field = if days.len() == 7 {
                "*".to_string()
            } else if days == [1, 2, 3, 4, 5] {
                "1-5".to_string()
            } else {
                days.iter().map(u8::to_string).collect::<Vec<_>>().join(",")
            };
            Ok(format!("{minute} {hour} * * {field}"))
        }
        ScheduleMode::Every => {
            let (mut amount, mut unit) = (schedule.every, schedule.unit);
            if unit == EveryUnit::Min && amount >= 60 && amount % 60 == 0 {
                amount /= 60;
                unit = EveryUnit::Hour;
            }
            if unit == EveryUnit::Min {
                return if EVERY_MINUTES.contains(&amount) {
                    Ok(format!("*/{amount} * * * *"))
                } else {
                    Err(format!("Every N minutes must divide 60 ({})", join(&EVERY_MINUTES)))
                };
            }
            if !EVERY_HOURS.contains(&amount) {
                return Err(format!("Every N hours must divide 24 ({})", join(&EVERY_HOURS)));
            }
            Ok(if amount == 24 { "0 0 * * *".into() } else { format!("0 */{amount} * * *") })
        }
    }
}

fn join(values: &[u32]) -> String {
    values.iter().map(u32::to_string).collect::<Vec<_>>().join(", ")
}

/// "9:05" or "09:05" as (hour, minute).
fn parse_time(text: &str) -> Option<(u32, u32)> {
    let (h, m) = text.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 || !h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (hour, minute): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (hour <= 23 && minute <= 59).then_some((hour, minute))
}

/// The form's schedule for a stored cron: Every or At when the form could have made it, Cron otherwise (`scheduleFromCron`).
pub fn schedule_from_cron(cron: &str, timezone: &str) -> ScheduleForm {
    let expression = cron.trim();
    let base = ScheduleForm {
        mode: ScheduleMode::Cron,
        every: 15,
        unit: EveryUnit::Min,
        time: "09:00".into(),
        days: vec![1, 2, 3, 4, 5],
        cron: expression.to_string(),
        timezone: timezone.into(),
    };
    let parts: Vec<&str> = expression.split_whitespace().collect();
    let [minute, hour, day_of_month, month, day_of_week] = parts[..] else { return base };
    if day_of_month != "*" || month != "*" {
        return base;
    }
    let step = |field: &str| {
        field.strip_prefix("*/").and_then(|n| n.parse::<u32>().ok()).filter(|_| field[2..].bytes().all(|b| b.is_ascii_digit()))
    };
    if let (Some(n), "*", "*") = (step(minute), hour, day_of_week)
        && EVERY_MINUTES.contains(&n)
    {
        return ScheduleForm { mode: ScheduleMode::Every, every: n, unit: EveryUnit::Min, ..base };
    }
    if let (Some(n), "0", "*") = (step(hour), minute, day_of_week)
        && EVERY_HOURS.contains(&n)
    {
        return ScheduleForm { mode: ScheduleMode::Every, every: n, unit: EveryUnit::Hour, ..base };
    }
    let plain = |field: &str, max: u32| {
        field.len() <= 2 && !field.is_empty() && field.bytes().all(|b| b.is_ascii_digit()) && field.parse::<u32>().is_ok_and(|v| v <= max)
    };
    if !plain(minute, 59) || !plain(hour, 23) {
        return base;
    }
    let days: Vec<u8> = match day_of_week {
        "*" => vec![0, 1, 2, 3, 4, 5, 6],
        "1-5" => vec![1, 2, 3, 4, 5],
        other if other.split(',').all(|d| d.len() == 1 && matches!(d.as_bytes()[0], b'0'..=b'6')) => {
            other.split(',').map(|d| d.parse().unwrap_or(0)).collect()
        }
        _ => return base,
    };
    let (h, m): (u32, u32) = (hour.parse().unwrap_or(0), minute.parse().unwrap_or(0));
    ScheduleForm { mode: ScheduleMode::At, time: format!("{h:02}:{m:02}"), days, ..base }
}

/// When a new schedule's first Run would start after `now`, on the wall clock of `zone` (an Every or At a time schedule;
/// a raw cron or another trigger gives `None`) (`firstRunAt`).
pub fn first_run_at(form: &RoutineForm, now: Millis, zone: &dyn Zone) -> Option<Millis> {
    if form.trigger != TriggerKind::Schedule {
        return None;
    }
    let schedule = &form.schedule;
    let wall = local_time(now, zone);
    let minutes_now = wall.hour * 60 + wall.minute;
    let offset = |at: Millis| i64::from(zone.offset_minutes(at)) * MINUTE_MS;
    // The moment the wall clock reads `minutes` into the day `days` after today's.
    let moment =
        |days: i64, minutes: i64| (days_from_civil(wall.year, wall.month, wall.day) + days) * DAY_MS + minutes * MINUTE_MS - offset(now);
    match schedule.mode {
        ScheduleMode::Every => {
            schedule_cron(schedule).ok()?;
            let step = i64::from(schedule.every) * if schedule.unit == EveryUnit::Hour { 60 } else { 1 };
            let next = (minutes_now / step + 1) * step;
            Some(moment(0, next.min(1440)))
        }
        ScheduleMode::At => {
            let (hour, minute) = parse_time(&schedule.time)?;
            let minutes = i64::from(hour * 60 + minute);
            (0..=7).find_map(|ahead| {
                let weekday = (wall.weekday + ahead).rem_euclid(7) as u8;
                if !schedule.days.contains(&weekday) {
                    return None;
                }
                let at = moment(ahead, minutes);
                (at > now).then_some(at)
            })
        }
        ScheduleMode::Cron => None,
    }
}

fn trigger_of(form: &RoutineForm) -> Result<Trigger, FormError> {
    match form.trigger {
        TriggerKind::Schedule => {
            let cron = schedule_cron(&form.schedule).or_else(|e| fail(Field::Schedule, e))?;
            let timezone = form.schedule.timezone.trim();
            if timezone.is_empty() {
                return fail(Field::Timezone, "Pick a timezone");
            }
            Ok(Trigger::Schedule { cron, timezone: timezone.into() })
        }
        TriggerKind::Linear => {
            let linear = &form.linear;
            let workspace = linear.workspace.trim();
            if workspace.is_empty() {
                return fail(Field::Workspace, "Pick a Linear workspace");
            }
            let opt = |text: &str| (!text.trim().is_empty()).then(|| text.trim().to_string());
            let mut label = None;
            let mut state = None;
            if linear.event == LinearEvent::LabelAdded {
                label = Some(opt(&linear.label).ok_or(FormError { field: Field::Label, error: "Pick the label to watch".into() })?);
            }
            if linear.event == LinearEvent::State {
                state = Some(opt(&linear.state).ok_or(FormError { field: Field::State, error: "Pick the state to watch".into() })?);
            }
            Ok(Trigger::Linear { workspace: workspace.into(), event: linear.event, team: opt(&linear.team), label, state })
        }
        TriggerKind::Webhook => Ok(Trigger::Webhook { hook_id: String::new(), signed: false }),
    }
}

fn target_of(form: &RoutineForm) -> Result<Target, FormError> {
    let project = form.project_path.trim();
    // The Mac still keeps a new-chat target on a listed Project for a comment Routine; its Runs never use it.
    if is_comment(form) {
        if project.is_empty() {
            return fail(Field::Project, "Pick a Project");
        }
        return Ok(Target::NewChat { project_path: form.project_path.clone(), workspace: Workspace::Worktree });
    }
    if form.run_in == RunIn::Chat {
        if form.trigger != TriggerKind::Schedule {
            return fail(Field::RunIn, CHAT_ONLY_SCHEDULE);
        }
        if form.chat_id.trim().is_empty() {
            return fail(Field::Chat, "Pick the Chat to check on");
        }
        return Ok(Target::Chat { chat_id: form.chat_id.clone() });
    }
    if project.is_empty() {
        return fail(Field::Project, "Pick a Project");
    }
    Ok(Target::NewChat {
        project_path: form.project_path.clone(),
        workspace: if form.run_in == RunIn::Project { Workspace::Project } else { Workspace::Worktree },
    })
}

/// The end the form names: (max Runs, expires at).
fn end_of(form: &RoutineForm, now: Millis) -> Result<(Option<u32>, Option<Millis>), FormError> {
    let stop = &form.stop;
    match stop.kind {
        StopKind::Runs => {
            if !(1..=MAX_RUNS_LIMIT).contains(&stop.runs) {
                return fail(Field::Stop, format!("Give a number of runs from 1 to {MAX_RUNS_LIMIT}"));
            }
            Ok((Some(stop.runs as u32), None))
        }
        StopKind::Date => {
            if stop.at <= now {
                return fail(Field::Stop, "Pick a date after today");
            }
            if stop.at > now + MAX_EXPIRY_MS {
                return fail(Field::Stop, "A Routine ends at most 30 days from now");
            }
            Ok((None, Some(stop.at)))
        }
        StopKind::Never if form.run_in == RunIn::Chat => fail(Field::Stop, "A Heartbeat needs an end"),
        StopKind::Never => Ok((None, None)),
    }
}

struct Common {
    name: String,
    prompt: String,
    trigger: Trigger,
    target: Target,
    max_runs: Option<u32>,
    expires_at: Option<Millis>,
}

fn common(form: &RoutineForm, now: Millis) -> Result<Common, FormError> {
    // A comment Routine's Each run is hidden: whatever it last held (even an existing Chat) doesn't count.
    let state = if is_comment(form) { RoutineForm { run_in: RunIn::Worktree, ..form.clone() } } else { form.clone() };
    let name = state.name.trim();
    if name.is_empty() {
        return fail(Field::Name, "Give the Routine a name");
    }
    if name.chars().count() > NAME_MAX {
        return fail(Field::Name, format!("A name is at most {NAME_MAX} characters"));
    }
    let trigger = trigger_of(&state)?;
    let target = target_of(&state)?;
    let prompt = state.prompt.trim();
    if prompt.is_empty() {
        return fail(Field::Prompt, "Write what the agent should do");
    }
    if prompt.chars().count() > PROMPT_MAX {
        return fail(Field::Prompt, format!("A prompt is at most {PROMPT_MAX} characters"));
    }
    let (max_runs, expires_at) = end_of(&state, now)?;
    Ok(Common { name: name.into(), prompt: prompt.into(), trigger, target, max_runs, expires_at })
}

/// The `routines:create` input the form makes.
#[derive(Clone, Debug, PartialEq)]
pub struct RoutineInput {
    pub name: String,
    pub prompt: String,
    pub trigger: Trigger,
    pub target: Target,
    pub signing_secret: Option<String>,
    pub signing_header: Option<String>,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub fallback: Option<Fallback>,
    pub max_runs: Option<u32>,
    pub expires_at: Option<Millis>,
}

fn text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The input a new Routine's form makes, or the field that is wrong and why (`formToInput`).
pub fn form_to_input(form: &RoutineForm, now: Millis) -> Result<RoutineInput, FormError> {
    let made = common(form, now)?;
    let mut trigger = made.trigger;
    let (mut signing_secret, mut signing_header) = (None, None);
    if let Trigger::Webhook { .. } = trigger {
        // The Mac mints the URL and its hook id; the form only says whether a signature is checked.
        let secret = text(&form.webhook.signing_secret);
        let signed = form.webhook.signed || secret.is_some();
        if signed && secret.is_none() {
            return fail(Field::SigningSecret, SIGNED_NEEDS_SECRET);
        }
        trigger = Trigger::Webhook { hook_id: String::new(), signed };
        if signed {
            signing_secret = secret;
            signing_header = text(&form.webhook.signing_header);
        }
    }
    Ok(RoutineInput {
        name: made.name,
        prompt: made.prompt,
        trigger,
        target: made.target,
        signing_secret,
        signing_header,
        provider: text(&form.model).and(form.provider),
        model: text(&form.model),
        permission_mode: text(&form.permission_mode),
        fallback: if fallback_applies(form) { fallback_of(form) } else { None },
        max_runs: made.max_runs,
        expires_at: made.expires_at,
    })
}

/// The form for editing `routine` (`formFromRoutine`).
pub fn form_from_routine(routine: &Routine, timezone: &str, now: Millis) -> RoutineForm {
    let mut form = empty_form(timezone, now);
    form.name = routine.name.clone();
    form.prompt = routine.prompt.clone();
    form.provider = routine.provider;
    form.model = routine.model.clone().unwrap_or_default();
    form.permission_mode = routine.permission_mode.clone().unwrap_or_default();
    if let Some(fallback) = &routine.fallback {
        form.fallback_provider = Some(fallback.provider);
        form.fallback_model = fallback.model.clone();
        form.fallback_effort = fallback.effort.clone().unwrap_or_default();
    }
    match &routine.trigger {
        Trigger::Schedule { cron, timezone } => {
            form.trigger = TriggerKind::Schedule;
            form.schedule = schedule_from_cron(cron, timezone);
        }
        Trigger::Linear { workspace, event, team, label, state } => {
            form.trigger = TriggerKind::Linear;
            form.linear = LinearForm {
                workspace: workspace.clone(),
                event: *event,
                team: team.clone().unwrap_or_default(),
                label: label.clone().unwrap_or_default(),
                state: state.clone().unwrap_or_default(),
            };
        }
        Trigger::Webhook { signed, .. } => {
            form.trigger = TriggerKind::Webhook;
            form.webhook = WebhookForm {
                signed: *signed,
                signing_header: routine.signing_header.clone().unwrap_or_default(),
                signing_secret: String::new(),
            };
        }
        // A babysit Heartbeat has no form; the closest the form can show is its schedule shape.
        Trigger::PullRequest { .. } => form.trigger = TriggerKind::Schedule,
    }
    match &routine.target {
        Target::Chat { chat_id } => {
            form.run_in = RunIn::Chat;
            form.chat_id = chat_id.clone();
        }
        Target::NewChat { project_path, workspace } => {
            form.run_in = if *workspace == Workspace::Project { RunIn::Project } else { RunIn::Worktree };
            form.project_path = project_path.clone();
        }
    }
    // The form shows one end; a Routine with both keeps its expiry in `at`, so an edit doesn't drop it.
    let at = routine.expires_at.unwrap_or(form.stop.at);
    if let Some(max) = routine.max_runs {
        form.stop = StopForm { kind: StopKind::Runs, runs: i64::from(max), at };
    } else if routine.expires_at.is_some() {
        form.stop = StopForm { kind: StopKind::Date, runs: form.stop.runs, at };
    }
    form
}

/// The `routines:update` patch for an edited Routine: everything the form holds, a `None` clearing the model, mode and
/// end. The trigger kind and whether Runs land in a Chat stay as they were; a comment Routine keeps its target.
#[derive(Clone, Debug, PartialEq)]
pub struct RoutinePatch {
    pub name: String,
    pub prompt: String,
    pub trigger: Trigger,
    /// `None`: left alone (a comment Routine keeps the target it has).
    pub target: Option<Target>,
    pub provider: Option<Provider>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// `None`: kept as the Routine has it (a Routine whose Runs never retry); `Some(None)` clears it.
    pub fallback: Option<Option<Fallback>>,
    pub max_runs: Option<u32>,
    pub expires_at: Option<Millis>,
    pub signing_secret: Option<String>,
    /// `Some(None)`: back to the default header.
    pub signing_header: Option<Option<String>>,
}

fn trigger_kind(trigger: &Trigger) -> Option<TriggerKind> {
    match trigger {
        Trigger::Schedule { .. } => Some(TriggerKind::Schedule),
        Trigger::Linear { .. } => Some(TriggerKind::Linear),
        Trigger::Webhook { .. } => Some(TriggerKind::Webhook),
        Trigger::PullRequest { .. } => None,
    }
}

/// The patch an edit saves (`formToUpdate`).
pub fn form_to_update(form: &RoutineForm, routine: &Routine, now: Millis) -> Result<RoutinePatch, FormError> {
    if Some(form.trigger) != trigger_kind(&routine.trigger) {
        return fail(Field::Trigger, "A Routine's trigger kind can't change");
    }
    let comment = is_comment(form) && matches!(routine.target, Target::NewChat { .. });
    if !comment && (form.run_in == RunIn::Chat) != matches!(routine.target, Target::Chat { .. }) {
        return fail(Field::RunIn, "Where a Routine's Runs land can't change between a Chat and new Chats");
    }
    let checked = match (&routine.target, comment) {
        (Target::NewChat { project_path, .. }, true) => RoutineForm { project_path: project_path.clone(), ..form.clone() },
        _ => form.clone(),
    };
    let made = common(&checked, now)?;
    let mut patch = RoutinePatch {
        name: made.name,
        prompt: made.prompt,
        trigger: made.trigger,
        target: if comment { None } else { Some(made.target) },
        provider: text(&form.model).and(form.provider),
        model: text(&form.model),
        permission_mode: text(&form.permission_mode),
        fallback: None,
        max_runs: made.max_runs,
        expires_at: made.expires_at,
        signing_secret: None,
        signing_header: None,
    };
    if let Trigger::Webhook { signed: was_signed, .. } = &routine.trigger {
        let secret = text(&form.webhook.signing_secret);
        let signed = secret.is_some() || form.webhook.signed;
        // Signing a webhook that had no secret needs one now, or every delivery would fail its check.
        if signed && secret.is_none() && !was_signed {
            return fail(Field::SigningSecret, SIGNED_NEEDS_SECRET);
        }
        patch.trigger = Trigger::Webhook { hook_id: String::new(), signed };
        patch.signing_secret = secret;
        if signed {
            patch.signing_header = Some(text(&form.webhook.signing_header));
        }
    }
    if fallback_applies(form) {
        patch.fallback = Some(fallback_of(form));
    }
    // A run cap picked over a stored expiry keeps that expiry: the form shows only one end.
    if form.stop.kind == StopKind::Runs && routine.max_runs.is_some() && routine.expires_at.is_some() {
        patch.expires_at = routine.expires_at;
    }
    Ok(patch)
}

/// A new Routine as the Mac would store it from `input` (fixture only: the id is the caller's).
pub fn routine_from_input(id: &str, input: &RoutineInput, now: Millis) -> Routine {
    let mut routine = Routine::new(id, input.name.clone(), input.trigger.clone(), input.target.clone());
    if let Trigger::Webhook { hook_id, signed } = &mut routine.trigger {
        *hook_id = format!("hk_{}", id.replace('-', ""));
        *signed = input.signing_secret.is_some();
    }
    routine.prompt = input.prompt.clone();
    routine.provider = input.provider;
    routine.model = input.model.clone();
    routine.permission_mode = input.permission_mode.clone();
    routine.fallback = input.fallback.clone();
    routine.max_runs = input.max_runs;
    routine.expires_at = input.expires_at;
    routine.signing_header = input.signing_header.clone();
    if matches!(routine.trigger, Trigger::Schedule { .. }) {
        routine.next_run_at = Some(now + 60 * MINUTE_MS);
    }
    routine
}

/// What `routines:update` does with a patch.
pub fn apply_patch(routine: &mut Routine, patch: &RoutinePatch) {
    routine.name = patch.name.clone();
    routine.prompt = patch.prompt.clone();
    routine.trigger = match (&routine.trigger, &patch.trigger) {
        // The hook id is the Mac's: only a rotate changes it.
        (Trigger::Webhook { hook_id, .. }, Trigger::Webhook { signed, .. }) => {
            Trigger::Webhook { hook_id: hook_id.clone(), signed: *signed }
        }
        (_, trigger) => trigger.clone(),
    };
    if let Some(target) = &patch.target {
        routine.target = target.clone();
    }
    routine.provider = patch.provider;
    routine.model = patch.model.clone();
    routine.permission_mode = patch.permission_mode.clone();
    if let Some(fallback) = &patch.fallback {
        routine.fallback = fallback.clone();
    }
    routine.max_runs = patch.max_runs;
    routine.expires_at = patch.expires_at;
    if let Some(header) = &patch.signing_header {
        routine.signing_header = header.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::usage::time::{FixedZone, epoch_ms};

    const NOW: Millis = 1_700_000_000_000;

    fn valid() -> RoutineForm {
        let mut form = empty_form("UTC", NOW);
        form.name = "Nightly".into();
        form.prompt = "Check the deps".into();
        form.project_path = "/code/app".into();
        form
    }

    fn every(amount: u32, unit: EveryUnit) -> ScheduleForm {
        ScheduleForm { every: amount, unit, ..valid().schedule }
    }

    #[test]
    fn every_schedules_make_the_crons_the_words_read_back() {
        assert_eq!(schedule_cron(&every(15, EveryUnit::Min)).unwrap(), "*/15 * * * *");
        assert_eq!(schedule_cron(&every(2, EveryUnit::Hour)).unwrap(), "0 */2 * * *");
        assert_eq!(schedule_cron(&every(24, EveryUnit::Hour)).unwrap(), "0 0 * * *");
        assert_eq!(schedule_cron(&every(60, EveryUnit::Min)).unwrap(), "0 */1 * * *");
        assert!(schedule_cron(&every(7, EveryUnit::Min)).unwrap_err().starts_with("Every N minutes must divide 60"));
        assert!(schedule_cron(&every(5, EveryUnit::Hour)).unwrap_err().starts_with("Every N hours must divide 24"));
    }

    #[test]
    fn at_a_time_schedules() {
        let at =
            |time: &str, days: &[u8]| ScheduleForm { mode: ScheduleMode::At, time: time.into(), days: days.to_vec(), ..valid().schedule };
        assert_eq!(schedule_cron(&at("08:30", &[1, 2, 3, 4, 5])).unwrap(), "30 8 * * 1-5");
        assert_eq!(schedule_cron(&at("9:05", &[0, 1, 2, 3, 4, 5, 6])).unwrap(), "5 9 * * *");
        assert_eq!(schedule_cron(&at("16:00", &[5, 1])).unwrap(), "0 16 * * 1,5");
        assert_eq!(schedule_cron(&at("24:00", &[1])).unwrap_err(), "Give a time as HH:MM");
        assert_eq!(schedule_cron(&at("08:30", &[])).unwrap_err(), "Pick at least one day");
        let cron = ScheduleForm { mode: ScheduleMode::Cron, cron: "  30   8 * * 1-5 ".into(), ..valid().schedule };
        assert_eq!(schedule_cron(&cron).unwrap(), "30 8 * * 1-5");
        assert_eq!(schedule_cron(&ScheduleForm { cron: String::new(), ..cron }).unwrap_err(), "Give a cron expression");
    }

    #[test]
    fn crons_round_trip_through_the_form() {
        for cron in ["*/15 * * * *", "*/1 * * * *", "0 */2 * * *", "0 0 * * *", "30 8 * * 1-5", "5 9 * * *", "0 16 * * 1,5", "0 7 * * 0,6"]
        {
            let schedule = schedule_from_cron(cron, "UTC");
            assert_ne!(schedule.mode, ScheduleMode::Cron, "{cron}");
            let made = schedule_cron(&schedule).unwrap();
            // "0 0 * * *" comes back as a daily time (the same cron), the rest verbatim.
            assert_eq!(made, cron, "{cron}");
        }
    }

    #[test]
    fn other_crons_stay_advanced() {
        for cron in ["0 9 1 * *", "*/7 * * * *", "0 */5 * * *", "30 8 * * 1-3", "0 9 * * 7", "1 2 3 4 5 6", "15,45 * * * *", "* * * * *"] {
            let schedule = schedule_from_cron(cron, "Europe/Lisbon");
            assert_eq!(
                (schedule.mode, schedule.cron.as_str(), schedule.timezone.as_str()),
                (ScheduleMode::Cron, cron, "Europe/Lisbon"),
                "{cron}"
            );
        }
    }

    #[test]
    fn a_valid_form_makes_the_create_input() {
        let input = form_to_input(&valid(), NOW).unwrap();
        assert_eq!(input.trigger, Trigger::Schedule { cron: "0 */1 * * *".into(), timezone: "UTC".into() });
        assert_eq!(input.target, Target::NewChat { project_path: "/code/app".into(), workspace: Workspace::Worktree });
        assert_eq!((input.max_runs, input.expires_at, input.model), (None, None, None));
        assert_eq!(input.fallback, None);
    }

    #[test]
    fn problems_name_their_field() {
        let check = |edit: &dyn Fn(&mut RoutineForm), field: Field, error: &str| {
            let mut form = valid();
            edit(&mut form);
            assert_eq!(form_to_input(&form, NOW), Err(FormError { field, error: error.into() }));
        };
        check(&|f| f.name = "  ".into(), Field::Name, "Give the Routine a name");
        check(&|f| f.name = "x".repeat(81), Field::Name, "A name is at most 80 characters");
        check(&|f| f.prompt = String::new(), Field::Prompt, "Write what the agent should do");
        check(&|f| f.prompt = "x".repeat(4001), Field::Prompt, "A prompt is at most 4000 characters");
        check(&|f| f.project_path = String::new(), Field::Project, "Pick a Project");
        check(&|f| f.schedule.timezone = String::new(), Field::Timezone, "Pick a timezone");
        check(&|f| f.schedule.every = 7, Field::Schedule, "Every N hours must divide 24 (1, 2, 3, 4, 6, 8, 12, 24)");
        check(&|f| f.run_in = RunIn::Chat, Field::Chat, "Pick the Chat to check on");
        check(
            &|f| {
                f.run_in = RunIn::Chat;
                f.chat_id = "p#c".into();
            },
            Field::Stop,
            "A Heartbeat needs an end",
        );
        check(
            &|f| {
                f.trigger = TriggerKind::Webhook;
                f.run_in = RunIn::Chat;
            },
            Field::RunIn,
            "Only schedule triggers can target an existing Chat",
        );
        check(&|f| f.trigger = TriggerKind::Linear, Field::Workspace, "Pick a Linear workspace");
        check(
            &|f| {
                f.trigger = TriggerKind::Linear;
                f.linear.workspace = "w".into();
            },
            Field::Label,
            "Pick the label to watch",
        );
        check(
            &|f| {
                f.trigger = TriggerKind::Linear;
                f.linear.workspace = "w".into();
                f.linear.event = LinearEvent::State;
            },
            Field::State,
            "Pick the state to watch",
        );
        check(
            &|f| {
                f.trigger = TriggerKind::Webhook;
                f.webhook.signed = true;
            },
            Field::SigningSecret,
            "A signed webhook needs a signing secret",
        );
    }

    #[test]
    fn the_stop_rules() {
        let stop = |kind, runs, at| {
            let mut form = valid();
            form.stop = StopForm { kind, runs, at };
            form_to_input(&form, NOW)
        };
        assert_eq!(stop(StopKind::Runs, 20, 0).unwrap().max_runs, Some(20));
        assert_eq!(stop(StopKind::Runs, 0, 0).unwrap_err().error, "Give a number of runs from 1 to 1000");
        assert_eq!(stop(StopKind::Runs, 1001, 0).unwrap_err().error, "Give a number of runs from 1 to 1000");
        assert_eq!(stop(StopKind::Date, 0, NOW + DAY_MS).unwrap().expires_at, Some(NOW + DAY_MS));
        assert_eq!(stop(StopKind::Date, 0, NOW).unwrap_err().error, "Pick a date after today");
        assert_eq!(stop(StopKind::Date, 0, NOW + 31 * DAY_MS).unwrap_err().error, "A Routine ends at most 30 days from now");
    }

    #[test]
    fn moving_to_a_chat_turns_never_into_a_week() {
        let moved = with_run_in(&valid(), RunIn::Chat, NOW);
        assert_eq!((moved.stop.kind, moved.stop.at), (StopKind::Date, NOW + 7 * DAY_MS));
        let mut runs = valid();
        runs.stop.kind = StopKind::Runs;
        assert_eq!(with_run_in(&runs, RunIn::Chat, NOW).stop.kind, StopKind::Runs);
    }

    #[test]
    fn a_signed_webhook_carries_its_secret_and_header() {
        let mut form = valid();
        form.trigger = TriggerKind::Webhook;
        form.webhook = WebhookForm { signed: false, signing_header: "x-sig".into(), signing_secret: "s3cret".into() };
        let input = form_to_input(&form, NOW).unwrap();
        assert_eq!(input.trigger, Trigger::Webhook { hook_id: String::new(), signed: true });
        assert_eq!((input.signing_secret.as_deref(), input.signing_header.as_deref()), (Some("s3cret"), Some("x-sig")));
    }

    #[test]
    fn a_comment_routine_has_no_each_run_and_no_fallback() {
        let mut form = valid();
        form.trigger = TriggerKind::Linear;
        form.linear = LinearForm {
            workspace: "w".into(),
            event: LinearEvent::Comment,
            team: String::new(),
            label: String::new(),
            state: String::new(),
        };
        form.run_in = RunIn::Chat;
        form.fallback_provider = Some(Provider::Claude);
        form.fallback_model = "claude-opus-5-5".into();
        assert!(!fallback_applies(&form));
        let input = form_to_input(&form, NOW).unwrap();
        assert_eq!(input.target, Target::NewChat { project_path: "/code/app".into(), workspace: Workspace::Worktree });
        assert_eq!(input.fallback, None);
    }

    fn stored() -> Routine {
        let mut routine = Routine::new(
            "r1",
            "Nightly",
            Trigger::Schedule { cron: "30 8 * * 1-5".into(), timezone: "UTC".into() },
            Target::NewChat { project_path: "/code/app".into(), workspace: Workspace::Project },
        );
        routine.prompt = "Check".into();
        routine.model = Some("claude-opus-5-5".into());
        routine.provider = Some(Provider::Claude);
        routine.max_runs = Some(20);
        routine.expires_at = Some(NOW + 3 * DAY_MS);
        routine
    }

    #[test]
    fn editing_a_routine_round_trips_it() {
        let routine = stored();
        let form = form_from_routine(&routine, "UTC", NOW);
        assert_eq!((form.schedule.mode, form.schedule.time.as_str()), (ScheduleMode::At, "08:30"));
        assert_eq!((form.run_in, form.stop.kind, form.stop.runs), (RunIn::Project, StopKind::Runs, 20));
        let patch = form_to_update(&form, &routine, NOW).unwrap();
        assert_eq!(patch.trigger, routine.trigger);
        assert_eq!(patch.target, Some(routine.target.clone()));
        assert_eq!((patch.max_runs, patch.model.as_deref()), (Some(20), Some("claude-opus-5-5")));
        // A run cap over a stored expiry keeps the expiry.
        assert_eq!(patch.expires_at, routine.expires_at);
        assert_eq!(patch.fallback, Some(None));
    }

    #[test]
    fn an_edit_cannot_change_the_trigger_kind_or_chat_target() {
        let routine = stored();
        let mut form = form_from_routine(&routine, "UTC", NOW);
        form.trigger = TriggerKind::Webhook;
        assert_eq!(form_to_update(&form, &routine, NOW).unwrap_err().field, Field::Trigger);
        let mut form = form_from_routine(&routine, "UTC", NOW);
        form.run_in = RunIn::Chat;
        assert_eq!(form_to_update(&form, &routine, NOW).unwrap_err().field, Field::RunIn);
    }

    #[test]
    fn clearing_the_model_and_end_sends_nothing() {
        let routine = stored();
        let mut form = form_from_routine(&routine, "UTC", NOW);
        form.model = String::new();
        form.stop.kind = StopKind::Never;
        let patch = form_to_update(&form, &routine, NOW).unwrap();
        assert_eq!((patch.model, patch.provider, patch.max_runs, patch.expires_at), (None, None, None, None));
    }

    #[test]
    fn a_stored_webhook_keeps_its_signing_unless_unchecked() {
        let mut routine = Routine::new(
            "w",
            "Hook",
            Trigger::Webhook { hook_id: "h1".into(), signed: true },
            Target::NewChat { project_path: "/code/app".into(), workspace: Workspace::Worktree },
        );
        routine.prompt = "Go".into();
        routine.signing_header = Some("x-sig".into());
        let form = form_from_routine(&routine, "UTC", NOW);
        let patch = form_to_update(&form, &routine, NOW).unwrap();
        assert_eq!(patch.trigger, Trigger::Webhook { hook_id: String::new(), signed: true });
        assert_eq!(patch.signing_header, Some(Some("x-sig".into())));
        // Signing a webhook that was not signed needs a secret.
        let mut open = routine.clone();
        open.trigger = Trigger::Webhook { hook_id: "h1".into(), signed: false };
        let mut form = form_from_routine(&open, "UTC", NOW);
        form.webhook.signed = true;
        assert_eq!(form_to_update(&form, &open, NOW).unwrap_err().field, Field::SigningSecret);
    }

    #[test]
    fn the_first_run_of_a_new_schedule() {
        let mut form = valid();
        let now = epoch_ms(2026, 11, 11, 12, 5, 0);
        // Every hour: the next whole hour.
        assert_eq!(first_run_at(&form, now, &FixedZone(0)), Some(epoch_ms(2026, 11, 11, 13, 0, 0)));
        form.schedule = ScheduleForm { every: 15, unit: EveryUnit::Min, ..form.schedule };
        assert_eq!(first_run_at(&form, now, &FixedZone(0)), Some(epoch_ms(2026, 11, 11, 12, 15, 0)));
        // At 08:30 on weekdays, after a Wednesday noon: Thursday.
        form.schedule = ScheduleForm { mode: ScheduleMode::At, time: "08:30".into(), ..form.schedule };
        assert_eq!(first_run_at(&form, now, &FixedZone(0)), Some(epoch_ms(2026, 11, 12, 8, 30, 0)));
        // The same clock read in UTC-3 is 09:05, so 08:30 local is next morning, 11:30 UTC.
        assert_eq!(first_run_at(&form, now, &FixedZone(-180)), Some(epoch_ms(2026, 11, 12, 11, 30, 0)));
        form.schedule.mode = ScheduleMode::Cron;
        assert_eq!(first_run_at(&form, now, &FixedZone(0)), None);
        form.trigger = TriggerKind::Webhook;
        assert_eq!(first_run_at(&form, now, &FixedZone(0)), None);
    }

    #[test]
    fn the_prompt_hint_names_the_data_rule() {
        assert_eq!(prompt_hint(TriggerKind::Schedule), "Type {{ for the Run's fields");
        assert!(prompt_hint(TriggerKind::Linear).ends_with("Issue text is passed as data, not instructions."));
        assert!(prompt_hint(TriggerKind::Webhook).ends_with("The request is passed as data, not instructions."));
    }
}

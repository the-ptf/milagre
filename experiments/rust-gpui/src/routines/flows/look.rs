//! `flow-look.ts`: the icon and tile colours of each step type, the glyph of each field type, and the words a Run is
//! described in on the page (its name, its headline, what the trigger did, its state chip).

use super::ops::{self, current_step, flatten};
use super::types::*;
use crate::data::Millis;
use crate::routines::model::{LinearEvent, Routine, Run, Trigger};
use crate::routines::words::{self, ZONE};
use crate::theme::Theme;
use crate::ui::IconName;

/// A step type's tile: its icon and the fill and ink behind it. `None` is the trigger's.
pub fn step_look(kind: Option<StepKind>, theme: &Theme) -> (IconName, gpui::Rgba, gpui::Rgba) {
    match kind {
        None => (IconName::Zap, theme.purple_tint, theme.purple_ink),
        Some(StepKind::Agent) => (IconName::Bot, theme.accent_tint, theme.accent_ink),
        Some(StepKind::If) => (IconName::Split, theme.field, theme.ink2),
        Some(StepKind::Ask) => (IconName::SecurityCheck, theme.orange_tint, theme.orange_ink),
        Some(StepKind::Wait) => (IconName::Hourglass, theme.purple_tint, theme.purple_ink),
        Some(StepKind::PullRequest) => (IconName::GitPullRequest, theme.green_tint, theme.green_ink),
        Some(StepKind::LinearComment) => (IconName::Message01, theme.green_tint, theme.green_ink),
    }
}

/// An output field's glyph on its chip and in the Output table (`FIELD_ICON`).
pub fn field_icon(ty: FieldType) -> IconName {
    match ty {
        FieldType::Text => IconName::TextFont,
        FieldType::Choice => IconName::LeftToRightListBullet,
        FieldType::YesNo => IconName::CheckmarkSquare02,
        FieldType::Number => IconName::Hashtag,
        FieldType::Link => IconName::Link01,
    }
}

/// What the flow reads its trigger as.
pub fn trigger_kind(trigger: &Trigger) -> TriggerKind {
    match trigger {
        Trigger::Schedule { .. } => TriggerKind::Schedule,
        Trigger::Linear { .. } => TriggerKind::Linear,
        Trigger::Webhook { .. } => TriggerKind::Webhook,
        Trigger::PullRequest { .. } => TriggerKind::PullRequest,
    }
}

/// What starts the flow, as its trigger card's title (`triggerTitle`).
pub fn trigger_title(trigger: &Trigger) -> &'static str {
    match trigger {
        Trigger::Schedule { .. } => "Schedule",
        Trigger::Webhook { .. } => "Webhook",
        Trigger::PullRequest { .. } => "Trigger",
        Trigger::Linear { event, .. } => match event {
            LinearEvent::Assigned => "Linear issue assigned",
            LinearEvent::State => "Linear issue moved",
            LinearEvent::Comment => "Linear comment",
            LinearEvent::LabelAdded => "Linear label added",
        },
    }
}

/// The trigger as a sentence for the page's subtitle (`triggerSentence`): "Starts when the agent label is added to a MIL
/// issue in Linear".
pub fn trigger_sentence(trigger: &Trigger) -> String {
    match trigger {
        Trigger::Linear { event, team, label, state, .. } => {
            let issue = team.as_deref().filter(|t| !t.is_empty()).map_or("an issue".to_string(), |team| format!("a {team} issue"));
            match event {
                LinearEvent::Assigned => format!("Starts when {issue} is assigned to you in Linear"),
                LinearEvent::State => {
                    format!("Starts when {issue} moves to {} in Linear", state.as_deref().filter(|s| !s.is_empty()).unwrap_or("a state"))
                }
                LinearEvent::Comment => format!("Starts on a new comment on {issue} in Linear"),
                LinearEvent::LabelAdded => format!(
                    "Starts when the {} label is added to {issue} in Linear",
                    label.as_deref().filter(|l| !l.is_empty()).unwrap_or("chosen")
                ),
            }
        }
        Trigger::Webhook { .. } => "Starts when its webhook gets a POST".into(),
        other => format!("Starts {}", words::trigger_text(other)),
    }
}

/// "2026-11-11 08:30" in the zone (`clock(at, undefined, true)`).
pub fn clock_with_date(at: Millis) -> String {
    let local = crate::logic::usage::time::local_time(at, &ZONE);
    format!("{:04}-{:02}-{:02} {}", local.year, local.month, local.day, local.time_24h())
}

/// The Linear issue a Run is for, as its key (`runIssueKey`).
pub fn run_issue_key(run: &Run) -> Option<&str> {
    match &run.event {
        Some(RunEvent::Linear { issue, .. }) => Some(issue.key.as_str()),
        _ => None,
    }
}

/// A Run's issue in a few words for the run bar (`runHeadline`).
pub fn run_headline(run: &Run) -> String {
    if let Some(RunEvent::Linear { issue, .. }) = &run.event {
        return format!("{} {}", issue.key, issue.title).trim().to_string();
    }
    if let Some(title) = run.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_string();
    }
    if run.flow.as_ref().is_some_and(|flow| flow.dry_run) {
        "Test run".into()
    } else {
        format!("Started {}", words::clock(run.started_at, &ZONE))
    }
}

/// What the trigger did for a Run, under the trigger's row (`triggerRunText`).
pub fn trigger_run_text(routine: &Routine, run: &Run) -> String {
    let at = words::clock(run.started_at, &ZONE);
    match &run.event {
        Some(RunEvent::Linear { change, issue, comment_author, .. }) => {
            let what = match change {
                LinearEvent::LabelAdded => match &routine.trigger {
                    Trigger::Linear { label: Some(label), .. } if !label.is_empty() => format!("{label} added to"),
                    _ => "label added to".into(),
                },
                LinearEvent::Assigned => "assigned".into(),
                LinearEvent::State => format!("moved to {} on", issue.state),
                LinearEvent::Comment => format!("comment by {} on", comment_author.as_deref().unwrap_or("someone")),
            };
            if *change == LinearEvent::Assigned {
                format!("{} assigned at {at}", issue.key)
            } else {
                format!("{what} {} at {at}", issue.key)
            }
        }
        Some(RunEvent::Webhook { .. }) => format!("Delivery at {at}"),
        _ => {
            if run.flow.as_ref().is_some_and(|flow| flow.dry_run) {
                format!("Test run at {at}")
            } else {
                format!("Started at {at}")
            }
        }
    }
}

/// The number a Run goes by on the page, or 0 for a Test run, which never counts (`runNumber`). Runs are kept newest first
/// and the oldest trimmed, so the count starts from the Routine's total.
fn run_number(routine: &Routine, run: &Run) -> u32 {
    if run.flow.as_ref().is_some_and(|flow| flow.dry_run) {
        return 0;
    }
    let counted: Vec<&Run> = routine.runs.iter().filter(|entry| !entry.flow.as_ref().is_some_and(|flow| flow.dry_run)).collect();
    let Some(index) = counted.iter().position(|entry| entry.id == run.id) else { return 0 };
    routine.run_count.saturating_sub(counted.len() as u32) + (counted.len() - index) as u32
}

/// A Run's name on the page: "Run 14", or "Test run" (`runName`).
pub fn run_name(routine: &Routine, run: &Run) -> String {
    match run_number(routine, run) {
        0 => "Test run".into(),
        number => format!("Run {number}"),
    }
}

/// A chip's tone: its fill and ink.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Accent,
    Orange,
    Green,
    Red,
    Field,
}

impl Tone {
    pub fn colors(self, theme: &Theme) -> (gpui::Rgba, gpui::Rgba) {
        match self {
            Tone::Accent => (theme.accent_tint, theme.accent_ink),
            Tone::Orange => (theme.orange_tint, theme.orange_ink),
            Tone::Green => (theme.green_tint, theme.green_ink),
            Tone::Red => (theme.red_tint, theme.red_ink),
            Tone::Field => (theme.field, theme.ink2),
        }
    }
}

/// A flow Run's state as its chip says it (`flowStatusLook`).
pub fn flow_status_look(flow: &FlowRun, waiting_for_you: bool) -> (&'static str, Tone) {
    match flow.status {
        FlowStatus::Running => ("Running", Tone::Accent),
        FlowStatus::Waiting if waiting_for_you => ("Waiting for you", Tone::Orange),
        FlowStatus::Waiting => ("Waiting", Tone::Field),
        FlowStatus::Paused => ("Paused", Tone::Field),
        FlowStatus::Failed => ("Stopped", Tone::Red),
        FlowStatus::Ended => ("Ended", Tone::Field),
        FlowStatus::Done => (if flow.dry_run { "Test run done" } else { "Done" }, Tone::Green),
    }
}

/// "4 min", "41 s": how long something took (`tookText`).
pub fn took_text(ms: i64) -> String {
    let seconds = (ms as f64 / 1000.0).round().max(0.0) as i64;
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let minutes = (seconds as f64 / 60.0).round() as i64;
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let hours = minutes / 60;
    if minutes % 60 > 0 { format!("{hours} h {} min", minutes % 60) } else { format!("{hours} h") }
}

/// The first line of an error, as a row shows it (`firstLine`).
pub fn first_line(text: Option<&str>) -> String {
    text.and_then(|t| t.lines().find(|l| !l.trim().is_empty())).map_or(String::new(), |l| l.trim().to_string())
}

/// The step a Run's view opens on: the one waiting for an answer, else the one it stopped at, else the one under way,
/// else the last one done (`defaultRunStep`).
pub fn default_run_step(run: Option<&Run>) -> String {
    let Some(flow) = run.and_then(|run| run.flow.as_ref()) else { return "trigger".into() };
    let current = current_step(flow);
    if let (true, Some(current)) = (ops::needs_answer(flow), current) {
        return current.id.clone();
    }
    if let Some(failed) = ops::failed_step(flow) {
        return failed.id.clone();
    }
    if let Some(current) = current {
        return current.id.clone();
    }
    flatten(&flow.steps)
        .into_iter()
        .rfind(|entry| flow.state.get(&entry.step.id).is_some_and(|run| run.status == StepStatus::Done))
        .map_or("trigger".into(), |entry| entry.step.id.clone())
}

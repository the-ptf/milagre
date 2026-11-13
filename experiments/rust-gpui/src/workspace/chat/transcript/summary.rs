//! What a reply's activity says about itself: the summary line, titles, durations, the marks' sources and the
//! detail sections. Pure functions, ported from `packages/shared/src/tool-activity.mjs` (`stepSource`,
//! `activitySources`, `formatStepDuration`, `stepDuration`, `activityDuration`, `stepSections`, `stepDisplayTitle`),
//! `packages/shared/src/reply-parts.ts` (`replyParts`, `activitySummary`, `titleSpans`, `formatDuration`,
//! `creditsText`) and `apps/desktop/app/src/lib/activity-window.ts`. `logic::activity` has none of them yet.

use std::collections::BTreeSet;

use gpui::SharedString;

use crate::data::{ChatStep, Millis, StepKind, StepStatus};

/// `ActivityEntry`: a reply's activity in the order it happened.
/// A step is the whole `ChatStep`; text entries are rare, so the size difference costs nothing.
#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Entry {
    Text(SharedString),
    Step(ChatStep),
}

impl Entry {
    pub fn step(&self) -> Option<&ChatStep> {
        match self {
            Entry::Step(step) => Some(step),
            Entry::Text(_) => None,
        }
    }
}

/// `replyActivity` for the kinds the fold shows: the reply's `body` and `steps` split into the activity (thinking,
/// tool steps and the text between them) and the answer, the reply's last text. Setup, image and artifact steps
/// are the cards' and the setup row's (other packages), so they stay out.
pub fn reply_activity(body: &str, steps: &[ChatStep]) -> (Vec<Entry>, String) {
    let split = reply_split(body, steps);
    let mut activity = split.before;
    activity.extend(split.after);
    (activity, split.answer)
}

/// A reply as `ReplyContent` (`ChatComposer.tsx`) lays it out: the activity before its answer (one fold), the
/// answer, and the activity after it (`answerAt`: a call the text led into, a second fold under the answer).
/// With no answer every entry is `before`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReplySplit {
    pub before: Vec<Entry>,
    pub answer: String,
    pub after: Vec<Entry>,
}

/// `replyParts` then `replyActivity`'s `activity`, `answer` and `answerAt`: steps next to each other form one group,
/// each at its offset in the text; text that is only whitespace is left out; the last text is the answer.
pub fn reply_split(body: &str, steps: &[ChatStep]) -> ReplySplit {
    enum Part {
        Text(String),
        Steps(Vec<ChatStep>),
    }
    let kept = steps.iter().filter(|step| !matches!(step.kind, Some(StepKind::Setup | StepKind::Image | StepKind::Artifact)));
    let mut parts: Vec<Part> = Vec::new();
    let mut cursor = 0usize;
    for step in kept {
        // `offset` counts UTF-16 units in the TypeScript; the fixture and adapters give it in bytes of the text.
        let at = step.offset.unwrap_or(body.len()).clamp(cursor, body.len());
        let at = (at..=body.len()).find(|at| body.is_char_boundary(*at)).unwrap_or(body.len());
        let text = &body[cursor..at];
        cursor = at;
        if !text.trim().is_empty() {
            parts.push(Part::Text(text.to_string()));
        }
        match parts.last_mut() {
            Some(Part::Steps(group)) => group.push(step.clone()),
            _ => parts.push(Part::Steps(vec![step.clone()])),
        }
    }
    let rest = &body[cursor..];
    if !rest.trim().is_empty() {
        parts.push(Part::Text(rest.to_string()));
    }
    let answer_at = parts.iter().rposition(|part| matches!(part, Part::Text(_)));
    let mut split = ReplySplit::default();
    for (index, part) in parts.into_iter().enumerate() {
        let after = answer_at.is_some_and(|at| index > at);
        let side = if after { &mut split.after } else { &mut split.before };
        match part {
            Part::Text(text) if Some(index) == answer_at => split.answer = text,
            Part::Text(text) => side.push(Entry::Text(text.into())),
            Part::Steps(group) => side.extend(group.into_iter().map(Entry::Step)),
        }
    }
    split
}

/// `count`: `one` for 1, else `many` with `#` replaced.
fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 { one.to_string() } else { many.replace('#', &n.to_string()) }
}

/// `formatDuration` (reply-parts): "4s", "1m 15s".
pub fn format_duration(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(1.0) as u64;
    if seconds < 60 { format!("{seconds}s") } else { format!("{}m {}s", seconds / 60, seconds % 60) }
}

/// `creditsText`: "0.04 credits", "1 credit", "<0.01 credits".
pub fn credits_text(credits: f64) -> String {
    if credits > 0.0 && credits < 0.01 {
        return "<0.01 credits".into();
    }
    let value = (credits * 100.0).round() / 100.0;
    format!("{value} {}", if value == 1.0 { "credit" } else { "credits" })
}

/// `activitySummary`: "Thought for 12s · read 2 files · ran 3 commands", and what it cost when the agent said.
/// Files count once however often they were read or edited. Also how many steps failed.
pub fn activity_summary(all: &[&ChatStep], credits: Option<f64>) -> (String, usize) {
    let steps: Vec<&&ChatStep> = all.iter().filter(|step| step.kind != Some(StepKind::Setup)).collect();
    let of = |kind: StepKind| steps.iter().filter(move |step| step.kind == Some(kind)).collect::<Vec<_>>();
    let files = |kind: StepKind| of(kind).iter().map(|step| step.title.clone()).collect::<BTreeSet<_>>().len();
    let thinking = of(StepKind::Thinking);
    let thinking_ms: u64 = thinking.iter().map(|step| step.duration_ms.unwrap_or(0)).sum();
    let parts = [
        if thinking.is_empty() {
            String::new()
        } else if thinking_ms > 0 {
            format!("thought for {}", format_duration(thinking_ms as f64))
        } else {
            "thought".into()
        },
        match files(StepKind::Read) {
            0 => String::new(),
            n => count(n, "read 1 file", "read # files"),
        },
        match of(StepKind::Search).len() {
            0 => String::new(),
            n => count(n, "searched once", "searched # times"),
        },
        match files(StepKind::Edit) {
            0 => String::new(),
            n => count(n, "edited 1 file", "edited # files"),
        },
        match of(StepKind::Shell).len() {
            0 => String::new(),
            n => count(n, "ran 1 command", "ran # commands"),
        },
        match of(StepKind::Other).len() {
            0 => String::new(),
            n => count(n, "used 1 tool", "used # tools"),
        },
        credits.filter(|c| c.is_finite()).map(credits_text).unwrap_or_default(),
    ];
    let text = parts.iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join(" · ");
    let mut chars = text.chars();
    let text = chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default();
    (text, steps.iter().filter(|step| step.status == StepStatus::Failed).count())
}

/// `titleSpans`: "Ran `npm test`" is "Ran " then the code "npm test".
pub fn title_spans(title: &str) -> Vec<(String, bool)> {
    title.split('`').enumerate().filter(|(_, text)| !text.is_empty()).map(|(index, text)| (text.to_string(), index % 2 == 1)).collect()
}

/// `stepSource`: what a mark stands for: a kind, or an MCP server (Linear has its own mark).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub id: String,
    pub label: String,
    pub kind: Option<StepKind>,
    pub linear: bool,
}

/// The MCP server an old message names only in its canonical title: "Used `tool` from Server".
fn server_from_title(title: &str) -> Option<&str> {
    let rest = title.strip_prefix("Used `")?;
    let rest = rest.split_once('`')?.1.strip_prefix(" from ")?;
    rest.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | ' ' | '.' | ':' | '-')).then_some(rest).filter(|s| !s.is_empty())
}

pub fn step_source(step: &ChatStep) -> Source {
    let server = step.source_server.as_deref().or_else(|| server_from_title(&step.title));
    if let Some(server) = server {
        let lower = server.to_lowercase();
        let linear = lower.split(['_', ' ', '-']).any(|word| word == "linear");
        return Source {
            id: format!("server:{lower}"),
            label: if linear { "Linear".into() } else { server.to_string() },
            kind: Some(StepKind::Other),
            linear,
        };
    }
    let label = match step.kind {
        Some(StepKind::Shell) => "Shell",
        Some(StepKind::Setup) => "Setup",
        Some(StepKind::Read) => "Read files",
        Some(StepKind::Edit) => "Edit files",
        Some(StepKind::Search) => "Search",
        Some(StepKind::Thinking) => "Thoughts",
        Some(StepKind::Image) => "Images",
        Some(StepKind::Artifact) => "Designs",
        Some(StepKind::Other) | None => "Tool",
    };
    Source { id: format!("{:?}", step.kind), label: label.into(), kind: step.kind, linear: false }
}

/// The order the summary names the kinds in, so each glyph sits over its own words; setup is not in the summary.
const SUMMARY_ORDER: [StepKind; 8] = [
    StepKind::Thinking,
    StepKind::Read,
    StepKind::Search,
    StepKind::Edit,
    StepKind::Shell,
    StepKind::Other,
    StepKind::Image,
    StepKind::Artifact,
];

/// `ActivitySources`: the kinds of work a folded reply did, one mark per kind in the summary's order, at most four.
pub fn activity_sources(steps: &[&ChatStep]) -> Vec<Source> {
    let mut seen: Vec<Source> = Vec::new();
    for step in steps.iter().filter(|step| step.kind != Some(StepKind::Setup)) {
        let source = step_source(step);
        if !seen.iter().any(|known| known.id == source.id) {
            seen.push(source);
        }
    }
    let rank = |source: &Source| source.kind.and_then(|kind| SUMMARY_ORDER.iter().position(|k| *k == kind)).unwrap_or(99);
    seen.sort_by_key(rank); // stable: ties keep their first-seen order
    seen.truncate(4);
    seen
}

/// `formatStepDuration`: "340ms", "1.2s", "2m 5s".
pub fn format_step_duration(ms: f64) -> String {
    if !ms.is_finite() || ms < 0.0 {
        return String::new();
    }
    if ms < 1000.0 {
        return format!("{}ms", ms.round());
    }
    if ms < 60_000.0 {
        let text = format!("{:.1}", ms / 1000.0);
        return format!("{}s", text.strip_suffix(".0").unwrap_or(&text));
    }
    let seconds = (ms / 1000.0).floor() as u64;
    format!("{}m {}s", seconds / 60, seconds % 60)
}

/// `stepDuration`: a running step counts from its start; a finished one says what it took.
pub fn step_duration(step: &ChatStep, now: Millis) -> String {
    if step.status == StepStatus::Running {
        return step.started_at.map(|start| format_step_duration((now - start).max(0) as f64)).unwrap_or_default();
    }
    step.duration_ms.map(|ms| format_step_duration(ms as f64)).unwrap_or_default()
}

/// `activityDuration`: wall time across the calls; parallel durations are never added.
pub fn activity_duration(steps: &[&ChatStep], active: bool, now: Millis) -> String {
    let Some(start) = steps.iter().filter_map(|step| step.started_at).min() else { return String::new() };
    let end = steps.iter().filter_map(|step| step.ended_at).max();
    if !active && end.is_none() {
        return String::new();
    }
    let end = if active { now } else { end.unwrap_or(now) };
    format_step_duration((end - start).max(0) as f64)
}

/// `stepSections`: the invocation and the retained output of a step, kept apart.
pub struct Sections {
    pub input_label: &'static str,
    pub input: String,
    pub output_label: &'static str,
    pub output: String,
}

pub fn step_sections(step: &ChatStep, detail: Option<&str>) -> Sections {
    let text = detail.or(step.detail.as_deref()).unwrap_or("");
    let console = matches!(step.kind, Some(StepKind::Shell | StepKind::Setup));
    if console && let Some(rest) = text.strip_prefix("$ ") {
        if let Some(input) = step.input.as_deref()
            && let Some(output) = rest.strip_prefix(input).and_then(|r| r.strip_prefix('\n'))
        {
            return Sections { input_label: "Command", input: input.into(), output_label: "Output", output: output.into() };
        }
        let (input, output) = rest.split_once('\n').unwrap_or((rest, ""));
        return Sections { input_label: "Command", input: input.into(), output_label: "Output", output: output.into() };
    }
    Sections {
        input_label: if console { "Command" } else { "Input" },
        input: step.input.clone().or_else(|| step.file.clone()).map(|s| s.to_string()).unwrap_or_default(),
        output_label: if step.kind == Some(StepKind::Edit) { "Changes" } else { "Output" },
        output: text.to_string(),
    }
}

/// `linkWorktreeProject`: the Project a Link Chat's `link_worktree_create` step names; `Some("")` for unreadable
/// arguments, `None` for any other step.
pub fn link_worktree_project(step: &ChatStep) -> Option<String> {
    if step.source_name.as_deref() != Some("link_worktree_create") {
        return None;
    }
    let project = step
        .input
        .as_deref()
        .and_then(|input| serde_json::from_str::<serde_json::Value>(input).ok())
        .and_then(|value| value.get("project").and_then(|p| p.as_str()).map(|p| p.trim().to_string()));
    Some(project.unwrap_or_default())
}

/// `stepDisplayTitle`: the title the row shows (MCP verbs, Link Worktrees), in the present tense while it runs.
pub fn step_display_title(step: &ChatStep, running: bool) -> String {
    let mut title = if step.kind == Some(StepKind::Thinking) && step.duration_ms.is_some() && step.title.starts_with("Thought for ") {
        "Thought".to_string()
    } else {
        step.title.to_string()
    };
    let has_source = step.source_name.is_some() || step.source_server.is_some();
    if let Some(project) = link_worktree_project(step) {
        title = if project.is_empty() { "Created Worktree".into() } else { format!("Created Worktree in {project}") };
    } else if has_source
        && (title.starts_with("Used `")
            || title.strip_prefix("Used ").is_some_and(|r| r.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_')))
    {
        let name = step.source_name.as_deref().unwrap_or("");
        let verb = match name {
            "get_issue" => Some("Read issue"),
            "list_issues" => Some("Listed issues"),
            "search_issues" => Some("Searched issues"),
            "update_issue" => Some("Updated issue"),
            "save_issue" => Some("Saved issue"),
            "create_issue" => Some("Created issue"),
            _ => None,
        };
        let words = name.replace(['_', '-'], " ");
        let mut action = verb.map(str::to_string).unwrap_or_else(|| {
            let mut chars = words.chars();
            chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        });
        let source = step_source(step);
        if source.linear
            && verb.is_some()
            && let Some(key) = step
                .input
                .as_deref()
                .and_then(|input| serde_json::from_str::<serde_json::Value>(input).ok())
                .and_then(|args| args.get("identifier").or_else(|| args.get("id")).and_then(|v| v.as_str()).map(str::to_string))
            && is_issue_key(&key)
            && let Some(base) = action.strip_suffix("issue")
        {
            action = format!("{base}`{key}`");
        }
        title = match &step.source_server {
            Some(_) => format!("{action} from {}", source.label),
            None => action,
        };
    }
    if running {
        const VERBS: [(&str, &str); 11] = [
            ("Ran", "Running"),
            ("Read", "Reading"),
            ("Edited", "Editing"),
            ("Wrote", "Writing"),
            ("Searched", "Searching"),
            ("Used", "Using"),
            ("Fetched", "Fetching"),
            ("Listed", "Listing"),
            ("Updated", "Updating"),
            ("Saved", "Saving"),
            ("Created", "Creating"),
        ];
        for (past, present) in VERBS {
            if let Some(rest) = title.strip_prefix(past)
                && rest.chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
            {
                title = format!("{present}{rest}");
                break;
            }
        }
    }
    title
}

/// `/^[A-Z][A-Z0-9]+-\d+$/i`.
fn is_issue_key(key: &str) -> bool {
    let Some((team, number)) = key.split_once('-') else { return false };
    let mut chars = team.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && team.len() >= 2
        && team.chars().all(|c| c.is_ascii_alphanumeric())
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

/// `ACTIVITY_CAP` and `ACTIVITY_PAGE` (`activity-window.ts`): an open fold of more than 200 entries starts at the last 150.
const ACTIVITY_CAP: usize = 200;
const ACTIVITY_PAGE: usize = 150;

/// `activityBoundary`: where the first open starts (`boundary` is a lower start asked for), lowered only to keep
/// waiting steps, and running steps while the reply streams, visible.
pub fn activity_boundary(entries: &[Entry], waiting: &[SharedString], streaming: bool, boundary: Option<usize>) -> usize {
    let boundary = boundary.unwrap_or(if entries.len() > ACTIVITY_CAP { entries.len() - ACTIVITY_PAGE } else { 0 });
    let end = boundary.min(entries.len());
    for (index, entry) in entries.iter().take(end).enumerate() {
        if let Entry::Step(step) = entry
            && ((streaming && step.status == StepStatus::Running) || waiting.contains(&step.id))
        {
            return index;
        }
    }
    end
}

/// `earlierStepsLabel`: "Show earlier steps (3,100, 2 failed)"; thinking and text are not counted.
pub fn earlier_steps_label(entries: &[Entry], hidden: usize) -> String {
    let (mut steps, mut failed) = (0usize, 0usize);
    for entry in entries.iter().take(hidden) {
        let Entry::Step(step) = entry else { continue };
        if step.kind == Some(StepKind::Thinking) {
            continue;
        }
        steps += 1;
        if step.status == StepStatus::Failed {
            failed += 1;
        }
    }
    let group = |n: usize| {
        let digits = n.to_string();
        let mut out = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                out.push(',');
            }
            out.push(c);
        }
        out
    };
    if failed > 0 {
        format!("Show earlier steps ({}, {} failed)", group(steps), group(failed))
    } else {
        format!("Show earlier steps ({})", group(steps))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: StepKind, title: &str) -> ChatStep {
        ChatStep { id: title.to_string().into(), kind: Some(kind), title: title.to_string().into(), ..Default::default() }
    }

    #[test]
    fn the_summary_reads_as_the_app_writes_it() {
        let mut think = step(StepKind::Thinking, "Thought for 12s");
        think.duration_ms = Some(12_000);
        let steps = [
            think,
            step(StepKind::Read, "Read `a.ts`"),
            step(StepKind::Read, "Read `a.ts`"),
            step(StepKind::Read, "Read `b.ts`"),
            step(StepKind::Shell, "Ran `npm test`"),
            step(StepKind::Shell, "Ran `cargo test`"),
        ];
        let refs: Vec<&ChatStep> = steps.iter().collect();
        assert_eq!(activity_summary(&refs, None), ("Thought for 12s · read 2 files · ran 2 commands".to_string(), 0));
        assert_eq!(activity_summary(&refs[..1], Some(0.004)).0, "Thought for 12s · <0.01 credits");
        assert_eq!(activity_summary(&refs[2..3], None).0, "Read 1 file");
    }

    #[test]
    fn marks_follow_the_summary_order_and_stop_at_four() {
        let steps = [
            step(StepKind::Shell, "Ran `a`"),
            step(StepKind::Edit, "Edited `x`"),
            step(StepKind::Search, "Searched `q`"),
            step(StepKind::Read, "Read `r`"),
            step(StepKind::Thinking, "Thought"),
            step(StepKind::Setup, "Setup"),
        ];
        let refs: Vec<&ChatStep> = steps.iter().collect();
        let kinds: Vec<_> = activity_sources(&refs).iter().map(|s| s.kind.unwrap()).collect();
        assert_eq!(kinds, [StepKind::Thinking, StepKind::Read, StepKind::Search, StepKind::Edit]);
    }

    #[test]
    fn durations_and_running_titles() {
        assert_eq!(format_step_duration(340.0), "340ms");
        assert_eq!(format_step_duration(1200.0), "1.2s");
        assert_eq!(format_step_duration(2000.0), "2s");
        assert_eq!(format_step_duration(125_000.0), "2m 5s");
        assert_eq!(format_duration(500.0), "1s");
        let mut running = step(StepKind::Shell, "Ran `npm test`");
        running.status = StepStatus::Running;
        running.started_at = Some(1_000);
        assert_eq!(step_display_title(&running, true), "Running `npm test`");
        assert_eq!(step_display_title(&running, false), "Ran `npm test`");
        assert_eq!(step_duration(&running, 4_500), "3.5s");
        assert_eq!(
            title_spans("Ran `npm test` now"),
            [("Ran ".to_string(), false), ("npm test".to_string(), true), (" now".to_string(), false)]
        );
    }

    #[test]
    fn mcp_steps_get_the_apps_verbs_and_linear_keys() {
        let mut linear = step(StepKind::Other, "Used `get_issue` from Linear");
        linear.source_name = Some("get_issue".into());
        linear.source_server = Some("Linear".into());
        linear.input = Some(r#"{"id":"not a key"}"#.into());
        assert_eq!(step_display_title(&linear, false), "Read issue from Linear");
        linear.input = Some(r#"{"identifier":"ENG-12"}"#.into());
        assert_eq!(step_display_title(&linear, false), "Read `ENG-12` from Linear");
        assert!(step_source(&linear).linear);
        let mut other = step(StepKind::Other, "Used `design_show` from milagre");
        other.source_name = Some("design_show".into());
        other.source_server = Some("milagre".into());
        assert_eq!(step_display_title(&other, true), "Design show from milagre");
    }

    #[test]
    fn a_reply_splits_into_activity_and_answer() {
        let mut first = step(StepKind::Read, "Read `a`");
        first.offset = Some(0);
        let mut second = step(StepKind::Shell, "Ran `b`");
        second.offset = Some(10);
        let (activity, answer) = reply_activity("Looking. Done and dusted.", &[first, second]);
        assert_eq!(activity.len(), 3, "step, the text before the second step, step");
        assert!(matches!(&activity[1], Entry::Text(text) if text.as_ref() == "Looking. D"));
        assert_eq!(answer, "one and dusted.");
    }

    #[test]
    fn long_folds_start_at_the_last_150_and_keep_waiting_steps() {
        let entries: Vec<Entry> = (0..250).map(|i| Entry::Step(step(StepKind::Read, &format!("Read {i}")))).collect();
        assert_eq!(activity_boundary(&entries, &[], false, None), 100);
        assert_eq!(activity_boundary(&entries, &["Read 30".into()], false, None), 30);
        assert_eq!(activity_boundary(&entries[..20], &[], false, None), 0);
        assert_eq!(earlier_steps_label(&entries, 100), "Show earlier steps (100)");
    }
}

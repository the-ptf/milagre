//! After `packages/shared/src/subchat-states.ts`: what each Subchat of a Chat is doing, for the Subchats pill above
//! that Chat's composer. A Subchat is a Chat whose session keeps this Chat's id as `parent`. Its finished report
//! shows in the transcript as one line ([`report_marker`]); the pill and its list carry the rest.

use crate::data::Outcome;
use crate::logic::copy::js;

/// In the order the pill counts them: what needs the user first, then live work, then what ended.
pub const SUBCHAT_KINDS: [SubchatKind; 7] = [
    SubchatKind::NeedsYou,
    SubchatKind::Failed,
    SubchatKind::Working,
    SubchatKind::Holding,
    SubchatKind::Queued,
    SubchatKind::Stopped,
    SubchatKind::Done,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubchatKind {
    NeedsYou,
    Failed,
    Working,
    Holding,
    Queued,
    Stopped,
    Done,
}

impl SubchatKind {
    /// The wire name (`"needs-you"`).
    pub fn key(self) -> &'static str {
        match self {
            SubchatKind::NeedsYou => "needs-you",
            SubchatKind::Failed => "failed",
            SubchatKind::Working => "working",
            SubchatKind::Holding => "holding",
            SubchatKind::Queued => "queued",
            SubchatKind::Stopped => "stopped",
            SubchatKind::Done => "done",
        }
    }

    /// `LABELS[kind]`.
    pub fn label(self) -> &'static str {
        match self {
            SubchatKind::NeedsYou => "Needs you",
            SubchatKind::Failed => "Failed",
            SubchatKind::Working => "Working",
            SubchatKind::Holding => "Holding",
            SubchatKind::Queued => "Queued",
            SubchatKind::Stopped => "Stopped",
            SubchatKind::Done => "Done",
        }
    }

    fn rank(self) -> usize {
        SUBCHAT_KINDS.iter().position(|kind| *kind == self).expect("in SUBCHAT_KINDS")
    }
}

/// One option of a question (`QuestionOption`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// One question an agent asks (`AgentQuestion`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentQuestion {
    pub id: String,
    /// A short tag such as "Library"; may be empty.
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub allow_other: bool,
    pub secret: bool,
}

/// The fields of a `PermissionRequest` the Subchat pill reads. (The full request has many more; the data layer
/// will carry it when approvals are ported.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRequest {
    pub request_id: String,
    pub title: String,
}

/// A question request: the questions under one request id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuestionRequest {
    pub request_id: String,
    pub questions: Vec<AgentQuestion>,
}

/// A pending question or approval of a Subchat's turn, answered from the parent Chat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubchatRequest {
    Question { request_id: String, questions: Vec<AgentQuestion> },
    Approval { request: ApprovalRequest },
}

/// The Subchat's live turn.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SubchatRun {
    pub text: Option<String>,
    pub started_at: Option<i64>,
    pub approvals: Vec<ApprovalRequest>,
    pub questions: Vec<QuestionRequest>,
    /// Request ids already answered (the keys of `answered`).
    pub answered: Vec<String>,
}

/// A Subchat's enabled Heartbeat.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Heartbeat {
    pub next_run_at: Option<i64>,
    pub run_count: Option<u64>,
    pub max_runs: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SubchatInput {
    pub key: String,
    pub title: String,
    /// `session.summary.lastOutcome`.
    pub last_outcome: Option<Outcome>,
    pub run: Option<SubchatRun>,
    /// A Delegation to it waits in its queue.
    pub queued: bool,
    pub heartbeat: Option<Heartbeat>,
    /// How its last report to this Chat ended, from the transcript.
    pub report: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubchatState {
    pub key: String,
    pub title: String,
    pub kind: SubchatKind,
    pub label: &'static str,
    /// One line under the title: the question, the latest line of work, the next beat or how it ended.
    pub detail: String,
    /// Elapsed time of a live turn, as "3m 05s".
    pub elapsed: Option<String>,
    /// The first unanswered question or approval, for the inline answers.
    pub request: Option<SubchatRequest>,
    /// For a Subchat deeper than this Chat's own: the title of the Chat that delegated to it.
    pub via: Option<String>,
}

/// `formatElapsed` (`display-clock.ts`): whole seconds for live elapsed labels: "42s", "3m 05s", "1h 02m 03s".
pub fn format_elapsed(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {:02}s", seconds % 60);
    }
    format!("{}h {:02}m {:02}s", minutes / 60, minutes % 60, seconds % 60)
}

/// `[label](target)` becomes `label`: `\[([^\]]*)\]\([^)]*\)`.
fn strip_links(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        if let Some(inner) = rest.strip_prefix('[')
            && let Some(close) = inner.find(']')
            && let Some(target) = inner[close + 1..].strip_prefix('(')
            && let Some(end) = target.find(')')
        {
            out.push_str(&inner[..close]);
            at += 1 + close + 1 + 1 + end + 1;
            continue;
        }
        let c = rest.chars().next().expect("at < len");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// `(`+|\*{1,3})([^`*]+)\1` becomes the middle: inline code and emphasis marks, when the same mark closes them.
fn strip_marks(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let mark = bytes[at];
        if mark == b'`' || mark == b'*' {
            let run = bytes[at..].iter().take_while(|b| **b == mark).count();
            // Backticks take the whole run; asterisks need a run of one to three (a longer run cannot start the
            // content with a non-asterisk).
            if mark == b'`' || run <= 3 {
                let content_start = at + run;
                let content_len = text[content_start..].bytes().take_while(|b| *b != b'`' && *b != b'*').count();
                let closer = content_start + content_len;
                if content_len > 0 && bytes[closer..].starts_with(&bytes[at..at + run]) {
                    out.push_str(&text[content_start..closer]);
                    at = closer + run;
                    continue;
                }
            }
        }
        let c = text[at..].chars().next().expect("at < len");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// Markdown read as plain text for a one-line detail: no code ticks, emphasis marks or link targets.
fn plain(text: &str) -> String {
    strip_marks(&strip_links(text)).replace('`', "")
}

/// `latestLine`: the last line the agent wrote, for a live row: one line, cut at the front when long (`max` is in
/// UTF-16 units, as in JavaScript; a cut never splits a character).
pub fn latest_line(text: Option<&str>, max: usize) -> String {
    let plain_text = plain(text.unwrap_or(""));
    let line = plain_text
        .split('\n')
        .map(|line| js::trim(line.trim_start_matches(|c: char| matches!(c, '#' | '>' | '*' | '-') || js::is_space(c))))
        .rfind(|line| !line.is_empty())
        .unwrap_or("");
    if js::utf16_len(line) > max { format!("\u{2026}{}", js::tail_utf16(line, max - 1)) } else { line.to_string() }
}

/// `latestLine` with the default 120.
pub fn latest_line_default(text: Option<&str>) -> String {
    latest_line(text, 120)
}

fn waiting_request(run: Option<&SubchatRun>) -> Option<SubchatRequest> {
    let run = run?;
    let unanswered = |id: &String| !run.answered.contains(id);
    if let Some(request) = run.approvals.iter().find(|request| unanswered(&request.request_id)) {
        return Some(SubchatRequest::Approval { request: request.clone() });
    }
    run.questions
        .iter()
        .find(|request| unanswered(&request.request_id))
        .map(|request| SubchatRequest::Question { request_id: request.request_id.clone(), questions: request.questions.clone() })
}

fn next_beat(heartbeat: &Heartbeat, now: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(next) = heartbeat.next_run_at {
        let minutes = js::round((next - now) as f64 / 60_000.0).max(0.0);
        parts.push(if minutes < 1.0 {
            "next beat now".to_string()
        } else if minutes < 60.0 {
            format!("next beat in {} min", minutes as i64)
        } else {
            format!("next beat in {} h", js::round_i64(minutes / 60.0))
        });
    }
    if let Some(max) = heartbeat.max_runs.filter(|max| *max > 0) {
        parts.push(format!("run {} of {max}", heartbeat.run_count.unwrap_or(0)));
    }
    if parts.is_empty() { "Heartbeat on".to_string() } else { parts.join(" \u{b7} ") }
}

/// `subchatState`: one Subchat's state: a pending request beats a live turn, which beats a queue, a Heartbeat and
/// how it ended.
pub fn subchat_state(input: &SubchatInput, now: i64) -> SubchatState {
    let make = |kind: SubchatKind, detail: String, elapsed: Option<String>, request: Option<SubchatRequest>| SubchatState {
        key: input.key.clone(),
        title: input.title.clone(),
        kind,
        label: kind.label(),
        detail,
        elapsed,
        request,
        via: None,
    };
    let run = input.run.as_ref();
    let elapsed = run.and_then(|run| run.started_at).map(|started| format_elapsed(now - started));
    if let Some(request) = waiting_request(run) {
        let detail = match &request {
            SubchatRequest::Approval { request } => format!("Asks to run: {}", request.title),
            SubchatRequest::Question { questions, .. } => {
                format!("Asks: {}", questions.first().map_or("a question", |q| q.question.as_str()))
            }
        };
        return make(SubchatKind::NeedsYou, detail, elapsed, Some(request));
    }
    if let Some(run) = run {
        let line = latest_line_default(run.text.as_deref());
        return make(SubchatKind::Working, if line.is_empty() { "Working".to_string() } else { line }, elapsed, None);
    }
    // A queued Delegation shows ahead of a Heartbeat, which shows ahead of how the last turn ended.
    if input.queued {
        return make(SubchatKind::Queued, "Starts after the Chat's running turn".to_string(), None, None);
    }
    if let Some(heartbeat) = &input.heartbeat {
        return make(SubchatKind::Holding, next_beat(heartbeat, now), None, None);
    }
    let ended = latest_line_default(input.report.as_deref());
    match input.last_outcome {
        Some(Outcome::Failed) => {
            make(SubchatKind::Failed, if ended.is_empty() { "Its last turn failed".to_string() } else { ended }, None, None)
        }
        Some(Outcome::Cancelled) => make(SubchatKind::Stopped, if ended.is_empty() { "Stopped".to_string() } else { ended }, None, None),
        _ => {
            let report = plain(input.report.as_deref().unwrap_or(""));
            let report = js::trim(&report);
            make(SubchatKind::Done, if report.is_empty() { "Finished".to_string() } else { report.to_string() }, None, None)
        }
    }
}

/// One count in the pill: `parts[i]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SummaryPart {
    pub kind: SubchatKind,
    pub text: String,
}

/// The one Subchat waiting on the user, when exactly one is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asking {
    pub key: String,
    pub title: String,
    pub ask: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SubchatSummary {
    /// The kind that leads the pill (its dot), the first one present in [`SUBCHAT_KINDS`] order.
    pub lead: Option<SubchatKind>,
    /// "1 needs you", "2 need you", "2 working", ..., in order; Stopped and Done count together as done.
    pub parts: Vec<SummaryPart>,
    pub asking: Option<Asking>,
}

/// `subchatAsk`: what a waiting Subchat wants, in the pill's few words.
pub fn subchat_ask(request: &SubchatRequest) -> String {
    match request {
        SubchatRequest::Approval { .. } => "wants to run a command".to_string(),
        SubchatRequest::Question { questions, .. } => questions.first().map_or("has a question", |q| q.question.as_str()).to_string(),
    }
}

/// `subchatSummary`: the pill's words for a set of Subchats.
pub fn subchat_summary(states: &[SubchatState]) -> SubchatSummary {
    let count = |kinds: &[SubchatKind]| states.iter().filter(|state| kinds.contains(&state.kind)).count();
    let mut parts = Vec::new();
    let mut add = |kind: SubchatKind, n: usize, text: &str| {
        if n > 0 {
            parts.push(SummaryPart { kind, text: format!("{n} {text}") });
        }
    };
    let waiting = count(&[SubchatKind::NeedsYou]);
    add(SubchatKind::NeedsYou, waiting, if waiting == 1 { "needs you" } else { "need you" });
    add(SubchatKind::Failed, count(&[SubchatKind::Failed]), "failed");
    add(SubchatKind::Working, count(&[SubchatKind::Working]), "working");
    add(SubchatKind::Holding, count(&[SubchatKind::Holding]), "holding");
    add(SubchatKind::Queued, count(&[SubchatKind::Queued]), "queued");
    add(SubchatKind::Done, count(&[SubchatKind::Done, SubchatKind::Stopped]), "done");
    let lead = SUBCHAT_KINDS.into_iter().find(|kind| states.iter().any(|state| state.kind == *kind));
    let only = if waiting == 1 { states.iter().find(|state| state.kind == SubchatKind::NeedsYou) } else { None };
    let asking = only.and_then(|only| {
        only.request.as_ref().map(|request| Asking { key: only.key.clone(), title: only.title.clone(), ask: subchat_ask(request) })
    });
    SubchatSummary { lead, parts, asking }
}

/// `sortSubchats`: Subchats first by what needs the user, then by the order they were made.
pub fn sort_subchats(states: &[SubchatState]) -> Vec<SubchatState> {
    let mut sorted = states.to_vec();
    sorted.sort_by_key(|state| state.kind.rank());
    sorted
}

/// A Delegation report's context (`ReportContext`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReportContext {
    pub kind: String,
    pub status: Option<String>,
    pub from_label: Option<String>,
    pub negotiation: bool,
}

/// `reportMarker`: the one line a Delegation report stands for in the transcript (its text opens on tap), or
/// `None` for a message that isn't one. Negotiation rounds keep their full text.
pub fn report_marker(context: Option<&ReportContext>) -> Option<(String, SubchatKind)> {
    let context = context.filter(|context| context.kind == "delegation-report" && !context.negotiation)?;
    let name = context.from_label.as_deref().unwrap_or("").split(" / ").last().filter(|name| !name.is_empty()).unwrap_or("A Chat");
    Some(match context.status.as_deref() {
        Some("failed") => (format!("{name} failed"), SubchatKind::Failed),
        Some("cancelled") => (format!("{name} stopped"), SubchatKind::Stopped),
        _ => (format!("{name} finished"), SubchatKind::Done),
    })
}

/// A transcript message as `latestReports` reads it: its body, and the sender when it is a Delegation report.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReportMessage {
    pub body: Option<String>,
    /// `context.kind` and `context.from`.
    pub context: Option<(String, Option<String>)>,
}

/// `latestReports`: the body of the latest Delegation report each Chat sent into this transcript, by the sender's
/// Chat key (in the order the senders first reported).
pub fn latest_reports(messages: &[ReportMessage]) -> Vec<(String, String)> {
    let mut reports: Vec<(String, String)> = Vec::new();
    for message in messages {
        let Some((kind, Some(from))) = &message.context else { continue };
        if kind != "delegation-report" {
            continue;
        }
        let body = message.body.clone().unwrap_or_default();
        match reports.iter_mut().find(|(key, _)| key == from) {
            Some(entry) => entry.1 = body,
            None => reports.push((from.clone(), body)),
        }
    }
    reports
}

/// The fields of a session the subchat helpers read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionRef {
    pub id: u64,
    pub parent: Option<u64>,
    pub archived: bool,
}

/// `Number(text)` for the digits after a key's `#`: the empty string is 0, junk is `None` (NaN).
fn key_number(text: &str) -> Option<u64> {
    let text = js::trim(text);
    if text.is_empty() { Some(0) } else { text.parse().ok() }
}

/// `directSubchats`: the Chats a Delegation from `key` made (its direct Subchats) that are still listed, oldest
/// first, as Chat keys.
pub fn direct_subchats(sessions: &[SessionRef], key: &str) -> Vec<String> {
    let Some(hash) = key.rfind('#') else { return Vec::new() };
    let Some(parent) = key_number(&key[hash + 1..]) else { return Vec::new() };
    let mut direct: Vec<u64> =
        sessions.iter().filter(|session| session.parent == Some(parent) && !session.archived).map(|session| session.id).collect();
    direct.sort_unstable();
    direct.into_iter().map(|id| format!("{}#{id}", &key[..hash])).collect()
}

/// `deeperSubchats`: the listed Chats below `key` that aren't its own Subchats, oldest first: the Subchats of its
/// Subchats, at any depth.
pub fn deeper_subchats(sessions: &[SessionRef], key: &str) -> Vec<String> {
    fn walk(sessions: &[SessionRef], from: &str, seen: &mut Vec<String>, deeper: &mut Vec<String>) {
        for child in direct_subchats(sessions, from) {
            if seen.contains(&child) {
                continue;
            }
            seen.push(child.clone());
            deeper.push(child.clone());
            walk(sessions, &child, seen, deeper);
        }
    }
    let mut seen = vec![key.to_string()];
    let mut deeper = Vec::new();
    let direct = direct_subchats(sessions, key);
    seen.extend(direct.iter().cloned());
    for at in &direct {
        walk(sessions, at, &mut seen, &mut deeper);
    }
    let number = |key: &String| key.rfind('#').and_then(|hash| key_number(&key[hash + 1..]));
    deeper.sort_by_key(number);
    deeper
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000_000;

    fn base() -> SubchatInput {
        SubchatInput { key: "p#2".into(), title: "Esconder valores".into(), ..Default::default() }
    }

    fn question() -> AgentQuestion {
        AgentQuestion {
            id: "q".into(),
            header: String::new(),
            question: "Publicar agora?".into(),
            options: vec![],
            multi_select: false,
            allow_other: true,
            secret: false,
        }
    }

    fn asking_run(request_id: &str) -> SubchatRun {
        SubchatRun { questions: vec![QuestionRequest { request_id: request_id.into(), questions: vec![question()] }], ..Default::default() }
    }

    fn state(key: &str, input: SubchatInput) -> SubchatState {
        subchat_state(&SubchatInput { key: key.into(), ..input }, NOW)
    }

    #[test]
    fn a_pending_question_beats_the_live_turn_and_an_answered_one_doesnt_count() {
        let run = SubchatRun { text: Some("Disparando o db-push".into()), started_at: Some(NOW - 185_000), ..asking_run("r1") };
        let asking = subchat_state(&SubchatInput { run: Some(run.clone()), ..base() }, NOW);
        assert_eq!(asking.kind, SubchatKind::NeedsYou);
        assert_eq!(asking.detail, "Asks: Publicar agora?");
        assert_eq!(asking.request, Some(SubchatRequest::Question { request_id: "r1".into(), questions: vec![question()] }));
        let answered = subchat_state(&SubchatInput { run: Some(SubchatRun { answered: vec!["r1".into()], ..run }), ..base() }, NOW);
        assert_eq!(answered.kind, SubchatKind::Working);
        assert_eq!(answered.detail, "Disparando o db-push");
        assert_eq!(answered.elapsed.as_deref(), Some("3m 05s"));
        assert_eq!(answered.label, "Working");
    }

    #[test]
    fn a_heartbeat_holds_a_chat_between_beats_how_the_last_turn_ended_shows_once_nothing_is_live() {
        let beat = Heartbeat { next_run_at: Some(NOW + 12 * 60_000), run_count: Some(3), max_runs: Some(20) };
        let holding = subchat_state(&SubchatInput { heartbeat: Some(beat), ..base() }, NOW);
        assert_eq!((holding.kind, holding.detail.as_str()), (SubchatKind::Holding, "next beat in 12 min \u{b7} run 3 of 20"));
        assert_eq!(subchat_state(&SubchatInput { queued: true, ..base() }, NOW).kind, SubchatKind::Queued);
        let failed = subchat_state(
            &SubchatInput { last_outcome: Some(Outcome::Failed), report: Some("Tried.\n\ndb-push failed: conflict".into()), ..base() },
            NOW,
        );
        assert_eq!((failed.kind, failed.detail.as_str()), (SubchatKind::Failed, "db-push failed: conflict"));
        assert_eq!(subchat_state(&SubchatInput { last_outcome: Some(Outcome::Cancelled), ..base() }, NOW).kind, SubchatKind::Stopped);
        let done = subchat_state(&SubchatInput { report: Some("Tudo publicado.".into()), ..base() }, NOW);
        assert_eq!((done.kind, done.detail.as_str()), (SubchatKind::Done, "Tudo publicado."));
        assert_eq!(subchat_state(&base(), NOW).detail, "Finished");
        assert_eq!(subchat_state(&SubchatInput { last_outcome: Some(Outcome::Failed), ..base() }, NOW).detail, "Its last turn failed");
        assert_eq!(subchat_state(&SubchatInput { last_outcome: Some(Outcome::Cancelled), ..base() }, NOW).detail, "Stopped");
        assert_eq!(subchat_state(&SubchatInput { run: Some(SubchatRun::default()), ..base() }, NOW).detail, "Working");
    }

    #[test]
    fn next_beat_rounds_and_reads_in_hours() {
        let beat = |next: Option<i64>, count: Option<u64>, max: Option<u64>| {
            next_beat(&Heartbeat { next_run_at: next, run_count: count, max_runs: max }, NOW)
        };
        assert_eq!(beat(Some(NOW + 20_000), None, None), "next beat now");
        assert_eq!(beat(Some(NOW + 40_000), None, None), "next beat in 1 min");
        assert_eq!(beat(Some(NOW - 5_000_000), None, None), "next beat now");
        assert_eq!(beat(Some(NOW + 90 * 60_000), None, None), "next beat in 2 h");
        assert_eq!(beat(None, None, Some(5)), "run 0 of 5");
        assert_eq!(beat(None, Some(2), None), "Heartbeat on");
    }

    #[test]
    fn the_pill_counts_what_needs_the_user_first_and_folds_stopped_into_done() {
        let states = sort_subchats(&[
            state("p#2", SubchatInput { report: Some("ok".into()), ..base() }),
            state("p#3", SubchatInput { run: Some(SubchatRun { text: Some("x".into()), ..Default::default() }), ..base() }),
            state("p#4", SubchatInput { last_outcome: Some(Outcome::Cancelled), ..base() }),
            state("p#5", SubchatInput { run: Some(asking_run("r")), ..base() }),
        ]);
        assert_eq!(states.iter().map(|s| s.key.as_str()).collect::<Vec<_>>(), vec!["p#5", "p#3", "p#4", "p#2"]);
        let summary = subchat_summary(&states);
        assert_eq!(summary.lead, Some(SubchatKind::NeedsYou));
        assert_eq!(summary.parts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["1 needs you", "1 working", "2 done"]);
        assert_eq!(subchat_summary(&[]), SubchatSummary::default());
    }

    #[test]
    fn a_report_is_one_transcript_line_naming_the_chat_negotiation_rounds_keep_their_text() {
        let context = |status: Option<&str>, from: Option<&str>, negotiation: bool, kind: &str| ReportContext {
            kind: kind.into(),
            status: status.map(Into::into),
            from_label: from.map(Into::into),
            negotiation,
        };
        assert_eq!(
            report_marker(Some(&context(Some("done"), Some("rd / feat/x / Esconder valores"), false, "delegation-report"))),
            Some(("Esconder valores finished".to_string(), SubchatKind::Done))
        );
        assert_eq!(
            report_marker(Some(&context(Some("failed"), Some("web"), false, "delegation-report"))).map(|m| m.0),
            Some("web failed".to_string())
        );
        assert_eq!(
            report_marker(Some(&context(Some("cancelled"), None, false, "delegation-report"))),
            Some(("A Chat stopped".to_string(), SubchatKind::Stopped))
        );
        assert_eq!(report_marker(Some(&context(None, None, true, "delegation-report"))), None);
        assert_eq!(report_marker(Some(&context(None, None, false, "delegation"))), None);
        assert_eq!(report_marker(None), None);
        let message = |body: Option<&str>, context: Option<(&str, Option<&str>)>| ReportMessage {
            body: body.map(Into::into),
            context: context.map(|(kind, from)| (kind.to_string(), from.map(Into::into))),
        };
        let reports = latest_reports(&[
            message(Some("first"), Some(("delegation-report", Some("p#2")))),
            message(Some("plain"), None),
            message(Some("second"), Some(("delegation-report", Some("p#2")))),
            message(Some("other"), Some(("delegation-report", Some("p#3")))),
            message(Some("nope"), Some(("handover", Some("p#4")))),
        ]);
        assert_eq!(reports, vec![("p#2".to_string(), "second".to_string()), ("p#3".to_string(), "other".to_string())]);
    }

    #[test]
    fn direct_subchats_are_the_listed_chats_that_keep_this_one_as_parent() {
        let s = |id: u64, parent: Option<u64>, archived: bool| SessionRef { id, parent, archived };
        let sessions = [s(1, None, false), s(4, Some(1), false), s(2, Some(1), false), s(3, Some(1), true), s(5, Some(2), false)];
        assert_eq!(direct_subchats(&sessions, "/p#1"), vec!["/p#2", "/p#4"]);
        assert_eq!(direct_subchats(&sessions, "no hash"), Vec::<String>::new());
        assert_eq!(direct_subchats(&sessions, "/p#x"), Vec::<String>::new());
        assert_eq!(latest_line_default(Some("# Plan\n\n- step one\n  last line  \n")), "last line");
    }

    #[test]
    fn details_read_markdown_as_plain_text() {
        assert_eq!(latest_line_default(Some("Wrote `A` to **note.txt**, see [the PR](https://x/1)")), "Wrote A to note.txt, see the PR");
        let done = subchat_state(&SubchatInput { report: Some("Wrote `hello` to `a.txt`.".into()), ..base() }, NOW);
        assert_eq!(done.detail, "Wrote hello to a.txt.");
        assert_eq!(latest_line_default(None), "");
    }

    #[test]
    fn plain_details_keep_underscores_in_names() {
        assert_eq!(latest_line_default(Some("Renamed `close_cash_session` in pos_v2")), "Renamed close_cash_session in pos_v2");
    }

    #[test]
    fn mark_stripping_edge_cases() {
        assert_eq!(latest_line_default(Some("***both*** and *one* and **two**")), "both and one and two");
        assert_eq!(latest_line_default(Some("a ** b")), "a ** b");
        assert_eq!(latest_line_default(Some("x **unclosed")), "x **unclosed");
        assert_eq!(latest_line_default(Some("``code with ` tick``")), "code with  tick");
        assert_eq!(latest_line_default(Some("**unclosed")), "unclosed");
        assert_eq!(latest_line_default(Some("[no link] (x) and [a](b")), "[no link] (x) and [a](b");
        assert_eq!(latest_line_default(Some("lone ` tick")), "lone  tick");
    }

    #[test]
    fn a_long_line_is_cut_at_the_front() {
        let line = "x".repeat(130);
        let cut = latest_line(Some(&line), 120);
        assert_eq!(cut.chars().count(), 120);
        assert!(cut.starts_with('\u{2026}'));
        assert_eq!(latest_line(Some(&"é".repeat(121)), 120).chars().count(), 120);
        assert_eq!(latest_line(Some("short"), 120), "short");
    }

    #[test]
    fn the_pill_names_who_is_asking_only_while_exactly_one_waits() {
        let asking = |key: &str| state(key, SubchatInput { run: Some(asking_run("r")), ..base() });
        let working = state("p#3", SubchatInput { run: Some(SubchatRun { text: Some("x".into()), ..Default::default() }), ..base() });
        assert_eq!(
            subchat_summary(&[asking("p#2"), working.clone()]).asking,
            Some(Asking { key: "p#2".into(), title: "Esconder valores".into(), ask: "Publicar agora?".into() })
        );
        let two = subchat_summary(&[asking("p#2"), asking("p#4")]);
        assert_eq!(two.asking, None);
        assert_eq!(two.parts[0].text, "2 need you");
        assert_eq!(subchat_summary(&[working]).asking, None);
        let approval =
            SubchatRun { approvals: vec![ApprovalRequest { request_id: "a".into(), title: "Run this?".into() }], ..Default::default() };
        let waiting = subchat_state(&SubchatInput { run: Some(approval), ..base() }, NOW);
        assert_eq!(waiting.detail, "Asks to run: Run this?");
        assert_eq!(subchat_summary(&[waiting]).asking.map(|a| a.ask), Some("wants to run a command".to_string()));
    }

    #[test]
    fn deeper_subchats_are_the_listed_ones_below_the_direct_ones_at_any_depth() {
        let s = |id: u64, parent: Option<u64>, archived: bool| SessionRef { id, parent, archived };
        let sessions = [s(1, None, false), s(2, Some(1), false), s(3, Some(2), false), s(4, Some(3), false), s(5, Some(3), true)];
        assert_eq!(deeper_subchats(&sessions, "/a#1"), vec!["/a#3", "/a#4"]);
        assert_eq!(deeper_subchats(&sessions, "/a#2"), vec!["/a#4"]);
        assert_eq!(deeper_subchats(&[s(1, Some(2), false), s(2, Some(1), false)], "/a#1"), Vec::<String>::new());
    }

    #[test]
    fn elapsed_reads_in_the_two_or_three_largest_units() {
        assert_eq!(format_elapsed(-5), "0s");
        assert_eq!(format_elapsed(42_900), "42s");
        assert_eq!(format_elapsed(185_000), "3m 05s");
        assert_eq!(format_elapsed(3_723_000), "1h 02m 03s");
    }
}

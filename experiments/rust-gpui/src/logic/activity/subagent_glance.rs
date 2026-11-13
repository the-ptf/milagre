//! After `packages/shared/src/subagent-glance.mjs`: what a subagent is doing, at a glance (the Subagents panel).
//! A subagent's transcript is its own words (message entries) between tool calls (tool entries): each message
//! starts a step, and the tool calls after it are counted by category, so the panel shows "Now checking the Notion
//! sheet" and "8 images · 2 commands" instead of the log.

use crate::logic::copy::js;

/// `StepKind`: the kind a provider gave a tool entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepKind {
    Shell,
    Edit,
    Read,
    Search,
    Other,
    Thinking,
    Setup,
    Image,
    Artifact,
}

/// `ToolCategory`, in `ORDER`: ties go to the calls that change more, edits then commands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolCategory {
    Edits,
    Commands,
    Images,
    Reads,
    Searches,
    Other,
}

impl ToolCategory {
    pub const ORDER: [ToolCategory; 6] = [
        ToolCategory::Edits,
        ToolCategory::Commands,
        ToolCategory::Images,
        ToolCategory::Reads,
        ToolCategory::Searches,
        ToolCategory::Other,
    ];

    /// The name the TypeScript uses as an object key.
    pub fn key(self) -> &'static str {
        match self {
            ToolCategory::Edits => "edits",
            ToolCategory::Commands => "commands",
            ToolCategory::Images => "images",
            ToolCategory::Reads => "reads",
            ToolCategory::Searches => "searches",
            ToolCategory::Other => "other",
        }
    }

    fn index(self) -> usize {
        Self::ORDER.iter().position(|category| *category == self).expect("in ORDER")
    }

    /// `LABELS[category]`: singular and plural.
    fn labels(self) -> (&'static str, &'static str) {
        match self {
            ToolCategory::Commands => ("command", "commands"),
            ToolCategory::Images => ("image", "images"),
            ToolCategory::Reads => ("file read", "files read"),
            ToolCategory::Searches => ("search", "searches"),
            ToolCategory::Edits => ("edit", "edits"),
            ToolCategory::Other => ("other tool", "other tools"),
        }
    }
}

/// Calls per category.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ToolCounts([u32; 6]);

impl ToolCounts {
    pub fn get(&self, category: ToolCategory) -> u32 {
        self.0[category.index()]
    }

    pub fn add(&mut self, category: ToolCategory) {
        self.0[category.index()] += 1;
    }

    /// Counts from `(category, count)` pairs.
    pub fn of(pairs: &[(ToolCategory, u32)]) -> Self {
        let mut counts = ToolCounts::default();
        for (category, count) in pairs {
            counts.0[category.index()] += count;
        }
        counts
    }
}

/// `/\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)\b/i`.
fn has_image_file(text: &str) -> bool {
    const EXTENSIONS: [&str; 10] = ["png", "jpeg", "jpg", "gif", "webp", "heic", "svg", "bmp", "tiff", "tif"];
    let bytes = text.as_bytes();
    text.match_indices('.').any(|(dot, _)| {
        let rest = &bytes[dot + 1..];
        EXTENSIONS.iter().any(|ext| {
            rest.len() >= ext.len()
                && rest[..ext.len()].eq_ignore_ascii_case(ext.as_bytes())
                && text[dot + 1 + ext.len()..].chars().next().is_none_or(|c| !js::is_word(c))
        })
    })
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("")
}

/// `kindOfTitle`: the kind of an entry a provider left without one, from its title.
fn kind_of_title(text: &str) -> StepKind {
    if text.starts_with("Ran ") {
        return StepKind::Shell;
    }
    if text.starts_with("Read ") || text.starts_with("Viewed ") {
        return if has_image_file(first_line(text)) { StepKind::Image } else { StepKind::Read };
    }
    if ["Edited ", "Wrote ", "Created ", "Deleted "].iter().any(|prefix| text.starts_with(prefix)) {
        return StepKind::Edit;
    }
    if ["Searched", "Found files", "Listed files"].iter().any(|prefix| text.starts_with(prefix)) {
        return StepKind::Search;
    }
    StepKind::Other
}

/// `toolCategory`: the category a tool call counts under; a read of an image file is an image.
pub fn tool_category(kind: Option<StepKind>, text: &str) -> ToolCategory {
    match kind.unwrap_or_else(|| kind_of_title(text)) {
        StepKind::Shell => ToolCategory::Commands,
        StepKind::Image => ToolCategory::Images,
        StepKind::Read => {
            if has_image_file(first_line(text)) {
                ToolCategory::Images
            } else {
                ToolCategory::Reads
            }
        }
        StepKind::Search => ToolCategory::Searches,
        StepKind::Edit => ToolCategory::Edits,
        _ => ToolCategory::Other,
    }
}

fn label(category: ToolCategory, count: u32) -> String {
    let (one, many) = category.labels();
    format!("{count} {}", if count == 1 { one } else { many })
}

/// `toolSummary`: "8 images · 2 commands": the categories with the most calls first, at most `limit` of them.
pub fn tool_summary(counts: &ToolCounts, limit: usize) -> String {
    let mut present: Vec<ToolCategory> = ToolCategory::ORDER.into_iter().filter(|category| counts.get(*category) > 0).collect();
    present.sort_by(|a, b| counts.get(*b).cmp(&counts.get(*a)).then(a.index().cmp(&b.index())));
    present.into_iter().take(limit).map(|category| label(category, counts.get(category))).collect::<Vec<_>>().join(" \u{b7} ")
}

/// A chip for the panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolChip {
    pub category: ToolCategory,
    pub count: u32,
    pub label: String,
}

/// `toolChips`: the counts per category as a list, in `ORDER`.
pub fn tool_chips(counts: &ToolCounts) -> Vec<ToolChip> {
    ToolCategory::ORDER
        .into_iter()
        .filter(|category| counts.get(*category) > 0)
        .map(|category| ToolChip { category, count: counts.get(category), label: label(category, counts.get(category)) })
        .collect()
}

/// `plainTitle`: a tool call's title as plain text, for a line that can't draw code.
pub fn plain_title(text: &str) -> String {
    text.replace('`', "")
}

/// `firstSentence`: the first sentence of what an agent said, without Markdown marks; the whole first line when
/// it has no sentence end.
pub fn first_sentence(text: &str) -> String {
    let line = text.split('\n').map(|part| js::trim(strip_list_marker(part))).find(|part| !part.is_empty()).unwrap_or("");
    // One pass, as `/\*\*|__|`/g` is: removing a mark never joins its neighbours into a new one.
    let plain = remove_marks(line);
    // /[.!?](\s|$)/
    let mut end = None;
    for (index, c) in plain.char_indices() {
        if matches!(c, '.' | '!' | '?') && plain[index + 1..].chars().next().is_none_or(js::is_space) {
            end = Some(index);
            break;
        }
    }
    js::trim(end.map_or(plain.as_str(), |index| &plain[..index + 1])).to_string()
}

/// `.replace(/\*\*|__|`/g, "")`.
fn remove_marks(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(c) = rest.chars().next() {
        if rest.starts_with("**") || rest.starts_with("__") {
            rest = &rest[2..];
        } else if c == '`' {
            rest = &rest[1..];
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// `.replace(/^\s*(#{1,6}\s+|[-*>]\s+|\d+\.\s+)/, "")`.
fn strip_list_marker(line: &str) -> &str {
    let body = line.trim_start_matches(js::is_space);
    let after_space = |rest: &'_ str| -> Option<usize> {
        let spaces = rest.len() - rest.trim_start_matches(js::is_space).len();
        (spaces > 0).then_some(spaces)
    };
    let hashes = body.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes)
        && let Some(spaces) = after_space(&body[hashes..])
    {
        return &body[hashes + spaces..];
    }
    if body.starts_with(['-', '*', '>'])
        && let Some(spaces) = after_space(&body[1..])
    {
        return &body[1 + spaces..];
    }
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0
        && body[digits..].starts_with('.')
        && let Some(spaces) = after_space(&body[digits + 1..])
    {
        return &body[digits + 1 + spaces..];
    }
    line
}

/// Whether an entry is a message or a tool call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Message,
    Tool,
}

/// `SubagentTranscriptEntry`, trimmed to what the glance reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub kind: EntryKind,
    pub text: Option<String>,
    pub tool: Option<StepKind>,
}

/// The final answer and the provider's own summary are the outcome, not a step.
fn is_outcome(entry: &Entry) -> bool {
    entry.id == "result" || entry.id == "summary"
}

/// Claude's tool results ride in the transcript as tool entries of their own; they aren't calls.
fn is_tool_result(entry: &Entry) -> bool {
    entry.id.starts_with("result:")
}

/// `isStep`: whether `entry` starts a step: something the agent said.
pub fn is_step(entry: &Entry) -> bool {
    entry.kind == EntryKind::Message && !is_outcome(entry) && entry.text.as_deref().is_some_and(|text| !js::trim(text).is_empty())
}

/// `isToolCall`: whether `entry` is a tool call that counts.
pub fn is_tool_call(entry: &Entry) -> bool {
    entry.kind == EntryKind::Tool && !is_tool_result(entry)
}

/// `SubagentProgress`: the host's running totals.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    pub steps: u32,
    pub said: Option<String>,
    pub tools: ToolCounts,
}

/// `addProgress`: `progress` with `entry` added; the host calls this once for each new transcript entry.
pub fn add_progress(progress: Option<Progress>, entry: &Entry) -> Progress {
    let mut current = progress.unwrap_or_default();
    if is_tool_call(entry) {
        current.tools.add(tool_category(entry.tool, entry.text.as_deref().unwrap_or("")));
    } else if is_step(entry) {
        current.steps += 1;
        current.said = Some(first_sentence(entry.text.as_deref().unwrap_or("")));
    }
    current
}

/// One step of a transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub id: String,
    pub said: String,
    pub text: String,
    pub tools: ToolCounts,
    pub last_tool: Option<String>,
}

/// `subagentSteps`: the steps of a whole transcript, oldest first: what the agent said and the tool calls that
/// followed, counted. Calls before the agent said anything make a first step without words.
pub fn subagent_steps(transcript: &[Entry]) -> Vec<Step> {
    let mut steps: Vec<Step> = Vec::new();
    for entry in transcript {
        if is_step(entry) {
            let text = entry.text.clone().unwrap_or_default();
            steps.push(Step { id: entry.id.clone(), said: first_sentence(&text), text, tools: ToolCounts::default(), last_tool: None });
        } else if is_tool_call(entry) {
            if steps.is_empty() {
                steps.push(Step {
                    id: format!("start:{}", entry.id),
                    said: String::new(),
                    text: String::new(),
                    tools: ToolCounts::default(),
                    last_tool: None,
                });
            }
            let text = entry.text.as_deref().unwrap_or("");
            let step = steps.last_mut().expect("a step exists");
            step.tools.add(tool_category(entry.tool, text));
            step.last_tool = Some(first_line(text).to_string());
        }
    }
    steps
}

/// `lastSaid`: the last thing a subagent said in `steps`; `None` before it said anything.
pub fn last_said(steps: &[Step]) -> Option<&str> {
    steps.iter().rev().map(|step| step.said.as_str()).find(|said| !said.is_empty())
}

/// `subagentOutcome`: the subagent's final answer or summary, first sentence; `None` while it has none.
pub fn subagent_outcome(transcript: &[Entry]) -> Option<String> {
    transcript
        .iter()
        .rev()
        .find(|entry| {
            entry.kind == EntryKind::Message && is_outcome(entry) && entry.text.as_deref().is_some_and(|text| !js::trim(text).is_empty())
        })
        .map(|entry| first_sentence(entry.text.as_deref().unwrap_or("")))
}

/// A subagent to-do's status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
}

/// `planCounts`: done and total of a subagent's own to-do list; `None` when it keeps none.
pub fn plan_counts(tasks: &[TaskStatus]) -> Option<(usize, usize)> {
    (!tasks.is_empty()).then(|| (tasks.iter().filter(|status| **status == TaskStatus::Completed).count(), tasks.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(id: &str, text: &str) -> Entry {
        Entry { id: id.into(), kind: EntryKind::Message, text: Some(text.into()), tool: None }
    }

    fn call(id: &str, text: &str, tool: Option<StepKind>) -> Entry {
        Entry { id: id.into(), kind: EntryKind::Tool, text: Some(text.into()), tool }
    }

    #[test]
    fn a_step_is_what_the_agent_said_with_the_tool_calls_after_it_counted_calls_before_any_words_make_a_first_step() {
        use ToolCategory::*;
        let steps = subagent_steps(&[
            call("c0", "Ran `ls`", Some(StepKind::Shell)),
            said("m1", "I'll compare the booking screens. Calendly first."),
            call("c1", "Read `sheet-1.jpg`", Some(StepKind::Read)),
            call("c2", "Read `notes.md`", Some(StepKind::Read)),
            Entry { id: "result:c2".into(), kind: EntryKind::Tool, text: Some("# Notes".into()), tool: None },
            call("c3", "Ran `curl https://example.com`", Some(StepKind::Shell)),
            said("m2", "**Now** I want to check the Notion sheet."),
            call("c4", "Read `sheet-notion.jpg`", None),
            said("result", "Two patterns are worth copying."),
        ]);
        let shape: Vec<(String, ToolCounts, Option<String>)> = steps.into_iter().map(|s| (s.said, s.tools, s.last_tool)).collect();
        assert_eq!(
            shape,
            vec![
                (String::new(), ToolCounts::of(&[(Commands, 1)]), Some("Ran `ls`".into())),
                (
                    "I'll compare the booking screens.".into(),
                    ToolCounts::of(&[(Images, 1), (Reads, 1), (Commands, 1)]),
                    Some("Ran `curl https://example.com`".into())
                ),
                ("Now I want to check the Notion sheet.".into(), ToolCounts::of(&[(Images, 1)]), Some("Read `sheet-notion.jpg`".into())),
            ]
        );
    }

    #[test]
    fn the_outcome_is_the_final_answers_first_sentence() {
        assert_eq!(
            subagent_outcome(&[said("m1", "Looking."), said("result", "Two screenshots are below 1290 px wide. Details follow.")])
                .as_deref(),
            Some("Two screenshots are below 1290 px wide.")
        );
        assert_eq!(subagent_outcome(&[said("m1", "Looking.")]), None);
        assert_eq!(subagent_outcome(&[said("summary", "  ")]), None);
    }

    #[test]
    fn first_sentence_drops_markdown_marks_and_keeps_a_line_without_a_sentence_end_whole() {
        assert_eq!(first_sentence("## Plan\nMore"), "Plan");
        assert_eq!(first_sentence("- Checking `auth.ts` now"), "Checking auth.ts now");
        assert_eq!(first_sentence("Version 1.5 is out! Then more."), "Version 1.5 is out!");
        assert_eq!(first_sentence(""), "");
        assert_eq!(first_sentence("3. Third step. Then."), "Third step.");
        assert_eq!(first_sentence("**bold** start"), "bold start");
        assert_eq!(first_sentence("####### seven"), "####### seven");
        assert_eq!(first_sentence("#nospace"), "#nospace");
        assert_eq!(first_sentence("\n\n  > quoted. more"), "quoted.");
    }

    #[test]
    fn tool_categories_come_from_the_step_kind_else_from_the_title_image_reads_are_images() {
        assert_eq!(tool_category(Some(StepKind::Read), "Read `a.PNG`"), ToolCategory::Images);
        assert_eq!(tool_category(Some(StepKind::Read), "Read `a.ts`"), ToolCategory::Reads);
        assert_eq!(tool_category(None, "Edited `a.ts`"), ToolCategory::Edits);
        assert_eq!(tool_category(None, "Searched for `x`"), ToolCategory::Searches);
        assert_eq!(tool_category(None, "Fetched `https://a.b`"), ToolCategory::Other);
        assert_eq!(tool_category(None, "Viewed `a.jpeg`"), ToolCategory::Images);
        assert_eq!(tool_category(None, "Ran `ls`"), ToolCategory::Commands);
        assert_eq!(tool_category(Some(StepKind::Thinking), "x"), ToolCategory::Other);
        // `\b` after the extension: a longer word is not an image.
        assert_eq!(tool_category(Some(StepKind::Read), "Read `a.pngx`"), ToolCategory::Reads);
        assert_eq!(tool_category(Some(StepKind::Read), "Read `a.tiff`"), ToolCategory::Images);
        assert_eq!(tool_category(Some(StepKind::Read), "Read `a.tif` and more"), ToolCategory::Images);
        // Only the first line of the title counts.
        assert_eq!(tool_category(Some(StepKind::Read), "Read `a.ts`\nb.png"), ToolCategory::Reads);
    }

    #[test]
    fn the_summary_names_the_busiest_categories_first_singular_or_plural() {
        use ToolCategory::*;
        assert_eq!(
            tool_summary(&ToolCounts::of(&[(Commands, 2), (Images, 8), (Edits, 1), (Reads, 1)]), 3),
            "8 images \u{b7} 2 commands \u{b7} 1 edit"
        );
        assert_eq!(tool_summary(&ToolCounts::of(&[(Reads, 1)]), 3), "1 file read");
        assert_eq!(tool_summary(&ToolCounts::default(), 3), "");
        assert_eq!(
            tool_summary(&ToolCounts::of(&[(Reads, 2), (Other, 2), (Searches, 2)]), 3),
            "2 files read \u{b7} 2 searches \u{b7} 2 other tools"
        );
        let chips = tool_chips(&ToolCounts::of(&[(Reads, 3), (Edits, 1)]));
        assert_eq!(chips.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), vec!["1 edit", "3 files read"]);
        assert_eq!(plain_title("Read `a.ts`"), "Read a.ts");
    }

    #[test]
    fn progress_counts_each_new_entry_once_steps_the_last_thing_said_and_calls_per_category() {
        let mut progress = add_progress(None, &said("m1", "Checking the rate limit. It is low."));
        progress = add_progress(Some(progress), &call("c1", "Ran `supabase`", Some(StepKind::Shell)));
        progress =
            add_progress(Some(progress), &Entry { id: "result:c1".into(), kind: EntryKind::Tool, text: Some("ok".into()), tool: None });
        progress = add_progress(Some(progress), &said("result", "Done."));
        assert_eq!(
            progress,
            Progress { steps: 1, said: Some("Checking the rate limit.".into()), tools: ToolCounts::of(&[(ToolCategory::Commands, 1)]) }
        );
    }

    #[test]
    fn plan_counts_are_none_without_a_list() {
        assert_eq!(plan_counts(&[]), None);
        assert_eq!(plan_counts(&[TaskStatus::Completed, TaskStatus::InProgress]), Some((1, 2)));
        assert_eq!(last_said(&subagent_steps(&[said("m", "One."), call("c", "x", None)])), Some("One."));
    }
}

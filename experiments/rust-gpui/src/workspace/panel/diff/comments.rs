//! `lib/diff-comments.ts`: where a line comment points, how it finds its rows again, and the Chat message that
//! carries the comments; plus the per-Chat store (`useDiffComments.ts`) and the draft a drag builds
//! (`useCommentDraft`).
//!
//! A comment keeps the rows it was written on as text (`snippet`: marker plus text) and the line numbers on its
//! side. It sits under its last row while the diff still has those rows with those numbers; otherwise it is
//! outdated (its file left the list, or its rows read differently now) and collects below the file's hunks.

use std::collections::HashMap;

use crate::logic::diff::{DiffHunk, DiffLine, LineKind};
use crate::ui::markdown::fences::resolve_code_language;
use crate::workspace::shell::persist::{self, JsonFile};

/// The column of a split view: old on the left, new on the right.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DiffSide {
    Old,
    New,
}

impl DiffSide {
    pub fn as_str(self) -> &'static str {
        match self {
            DiffSide::Old => "old",
            DiffSide::New => "new",
        }
    }
}

/// `ChangesMode`: the diff a comment was written on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum ChangesMode {
    #[default]
    Uncommitted,
    Committed,
    Pr,
}

/// `DiffComment`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffComment {
    pub id: String,
    pub path: String,
    pub side: DiffSide,
    pub start: u32,
    pub end: u32,
    /// The selected rows as the diff shows them: a `+`, `-` or space marker, then the text.
    pub snippet: Vec<String>,
    pub body: String,
    pub created_at: i64,
    pub mode: ChangesMode,
}

/// `DiffSelection`: what a range of rows comments on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffSelection {
    pub side: DiffSide,
    pub start: u32,
    pub end: u32,
    pub snippet: Vec<String>,
}

/// Where a comment sits now: the hunk and the indexes of its lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub hunk: usize,
    pub lines: Vec<usize>,
}

const MAX_SNIPPET_LINES: usize = 40;

fn marker(kind: LineKind) -> char {
    match kind {
        LineKind::Add => '+',
        LineKind::Remove => '-',
        LineKind::Context => ' ',
    }
}

/// A row as a snippet keeps it.
pub fn row_text(line: &DiffLine) -> String {
    let mut text = String::with_capacity(line.text.len() + 1);
    text.push(marker(line.kind));
    text.push_str(&line.text);
    text
}

fn row_matches(line: &DiffLine, row: &str) -> bool {
    let mut chars = row.chars();
    chars.next() == Some(marker(line.kind)) && chars.as_str() == line.text
}

/// `onSide`: whether a line is shown in that column of a split view.
pub fn on_side(line: &DiffLine, side: DiffSide) -> bool {
    match line.kind {
        LineKind::Context => true,
        LineKind::Remove => side == DiffSide::Old,
        LineKind::Add => side == DiffSide::New,
    }
}

fn number_on(line: &DiffLine, side: DiffSide) -> Option<u32> {
    match side {
        DiffSide::Old => line.old_number,
        DiffSide::New => line.new_number,
    }
}

/// `extensionOf`: the name's extension, or the whole name when it has none (`Makefile`).
pub fn extension_of(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot + 1..],
        _ => name,
    }
}

/// `selectionFromRows`: the comment target for the lines between two indexes of a hunk. `side` is the column of a
/// split view, which keeps only that column's lines; without it (unified) every line in between is kept and the
/// side follows the numbers.
pub fn selection_from_rows(hunk: &DiffHunk, from_row: usize, to_row: usize, side: Option<DiffSide>) -> Option<DiffSelection> {
    let lo = from_row.min(to_row);
    let hi = from_row.max(to_row);
    let end = (hi + 1).min(hunk.lines.len());
    let lines: Vec<&DiffLine> = hunk.lines.get(lo..end)?.iter().filter(|line| side.is_none_or(|side| on_side(line, side))).collect();
    if lines.is_empty() {
        return None;
    }
    let resolved = side.unwrap_or(if lines.iter().any(|line| line.new_number.is_some()) { DiffSide::New } else { DiffSide::Old });
    let numbers: Vec<u32> = lines.iter().filter_map(|line| number_on(line, resolved)).collect();
    let (start, end) = (*numbers.iter().min()?, *numbers.iter().max()?);
    Some(DiffSelection { side: resolved, start, end, snippet: lines.iter().map(|line| row_text(line)).collect() })
}

/// `locateComment`: the hunk and line indexes the comment's rows are at now, or `None` once the diff no longer has
/// them (with the same numbers).
pub fn locate_comment(comment: &DiffComment, hunks: &[DiffHunk]) -> Option<Located> {
    let snippet = &comment.snippet;
    for (h, hunk) in hunks.iter().enumerate() {
        let all: Vec<usize> = (0..hunk.lines.len()).collect();
        // A split selection skips the other column's lines in between, so try that reading too.
        let column: Vec<usize> = all.iter().copied().filter(|&i| on_side(&hunk.lines[i], comment.side)).collect();
        for indexes in [&all, &column] {
            if snippet.len() > indexes.len() {
                continue;
            }
            for i in 0..=indexes.len() - snippet.len() {
                let window = &indexes[i..i + snippet.len()];
                if !window.iter().zip(snippet).all(|(&ix, row)| row_matches(&hunk.lines[ix], row)) {
                    continue;
                }
                let numbers: Vec<u32> = window.iter().filter_map(|&ix| number_on(&hunk.lines[ix], comment.side)).collect();
                if numbers.iter().min() == Some(&comment.start) && numbers.iter().max() == Some(&comment.end) {
                    return Some(Located { hunk: h, lines: window.to_vec() });
                }
            }
        }
    }
    None
}

/// `isOutdated`: the lines are gone or changed since the comment was written.
pub fn is_outdated(comment: &DiffComment, hunks: &[DiffHunk]) -> bool {
    locate_comment(comment, hunks).is_none()
}

/// `labelFor`: `L12`, or `L12–15`.
pub fn label_for(start: u32, end: u32) -> String {
    if start == end { format!("L{start}") } else { format!("L{start}\u{2013}{end}") }
}

fn fenced(rows: &[String], language: Option<&str>) -> String {
    let mut shown: Vec<String> = rows.iter().take(MAX_SNIPPET_LINES).cloned().collect();
    if rows.len() > MAX_SNIPPET_LINES {
        shown.push(format!("\u{2026} ({} more lines)", rows.len() - MAX_SNIPPET_LINES));
    }
    // A snippet that itself holds a fence needs a longer one around it.
    let longest = rows.iter().map(|row| longest_backtick_run(row)).max().unwrap_or(0);
    let longest = if longest >= 3 { longest } else { 0 };
    let fence = "`".repeat((longest + 1).max(3));
    let mut out = vec![format!("{fence}{}", language.unwrap_or(""))];
    out.extend(shown);
    out.push(fence);
    out.join("\n")
}

/// The longest run of three or more backticks in `row` (`/`{3,}/g`), else 0.
fn longest_backtick_run(row: &str) -> usize {
    let mut best = 0;
    let mut run = 0;
    for c in row.chars() {
        if c == '`' {
            run += 1;
        } else {
            if run >= 3 {
                best = best.max(run);
            }
            run = 0;
        }
    }
    if run >= 3 { best.max(run) } else { best }
}

/// The scope a message names: the uncommitted changes, or the committed ones against a base.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageScope {
    Uncommitted,
    Committed,
}

/// `formatCommentsMessage`: the one Chat message that carries every comment, each with the lines it is about.
pub fn format_comments_message(comments: &[DiffComment], scope: MessageScope, base: Option<&str>) -> String {
    let scope = match (scope, base.filter(|b| !b.is_empty())) {
        (MessageScope::Uncommitted, _) => "uncommitted changes".to_string(),
        (MessageScope::Committed, Some(base)) => format!("committed changes against {base}"),
        (MessageScope::Committed, None) => "committed changes".to_string(),
    };
    let entries: Vec<String> = comments
        .iter()
        .enumerate()
        .map(|(index, comment)| {
            let lines = if comment.start == comment.end {
                format!("line {}", comment.start)
            } else {
                format!("lines {}\u{2013}{}", comment.start, comment.end)
            };
            let language = resolve_code_language(Some(extension_of(&comment.path)));
            format!(
                "{}. {}, {} ({}):\n{}\n{}",
                index + 1,
                comment.path,
                lines,
                comment.side.as_str(),
                fenced(&comment.snippet, language),
                comment.body
            )
        })
        .collect();
    format!("Review comments on the diff ({scope}):\n\n{}", entries.join("\n\n"))
}

/// A comment as the diff shows it: with whether it is outdated against the diff on screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommentView {
    pub comment: DiffComment,
    pub outdated: bool,
}

/// The Chats' comments (`useDiffComments`). The desktop keeps them in `localStorage` under
/// `milagre:diff-comments:<chat>`; here they are one JSON file per app (`diff-comments.json` in the state directory,
/// see `shell::persist`), so they last across launches. The Changes diff and the PR's diff each hold a store; a
/// change rewrites only its own mode's comments of that Chat in the file, so neither clobbers the other.
#[derive(Clone, Debug, Default)]
pub struct CommentStore {
    by_chat: HashMap<String, Vec<DiffComment>>,
    next_id: u64,
    file: Option<JsonFile>,
}

fn mode_name(mode: ChangesMode) -> &'static str {
    match mode {
        ChangesMode::Uncommitted => "uncommitted",
        ChangesMode::Committed => "committed",
        ChangesMode::Pr => "pr",
    }
}

fn to_json(comment: &DiffComment) -> serde_json::Value {
    serde_json::json!({
        "id": comment.id,
        "path": comment.path,
        "side": comment.side.as_str(),
        "start": comment.start,
        "end": comment.end,
        "snippet": comment.snippet,
        "body": comment.body,
        "createdAt": comment.created_at,
        "mode": mode_name(comment.mode),
    })
}

fn from_json(value: &serde_json::Value) -> Option<DiffComment> {
    let text = |key: &str| value.get(key)?.as_str().map(str::to_string);
    let number = |key: &str| value.get(key)?.as_u64().and_then(|n| u32::try_from(n).ok());
    Some(DiffComment {
        id: text("id")?,
        path: text("path")?,
        side: if text("side")? == "old" { DiffSide::Old } else { DiffSide::New },
        start: number("start")?,
        end: number("end")?,
        snippet: value.get("snippet")?.as_array()?.iter().filter_map(|row| row.as_str().map(str::to_string)).collect(),
        body: text("body")?,
        created_at: value.get("createdAt")?.as_i64()?,
        mode: match text("mode")?.as_str() {
            "committed" => ChangesMode::Committed,
            "pr" => ChangesMode::Pr,
            _ => ChangesMode::Uncommitted,
        },
    })
}

/// What a file holds: Chat key to its comments. Anything malformed is left out.
fn read_all(file: &JsonFile) -> HashMap<String, Vec<DiffComment>> {
    let Some(serde_json::Value::Object(chats)) = file.read() else { return HashMap::new() };
    chats
        .iter()
        .filter_map(|(chat, list)| Some((chat.clone(), list.as_array()?.iter().filter_map(from_json).collect::<Vec<_>>())))
        .collect()
}

impl CommentStore {
    /// A store kept in the app's state file; in memory only while persistence is off (snapshots, tests).
    pub fn new() -> Self {
        Self::with_file(persist::file("diff-comments.json"))
    }

    /// A store kept in `file`, loaded now.
    pub fn with_file(file: Option<JsonFile>) -> Self {
        let by_chat = file.as_ref().map(read_all).unwrap_or_default();
        let next_id = Self::highest_id(by_chat.values().flatten());
        Self { by_chat, next_id, file }
    }

    fn highest_id<'a>(comments: impl Iterator<Item = &'a DiffComment>) -> u64 {
        comments.filter_map(|c| c.id.strip_prefix('c')?.parse::<u64>().ok()).max().unwrap_or(0)
    }

    /// Writes `chat`'s comments of `mode` into the file, keeping what the file holds for its other modes (another
    /// store's) and other Chats.
    fn save(&self, chat: &str, mode: ChangesMode) {
        let Some(file) = &self.file else { return };
        let mut all = read_all(file);
        let theirs = all.remove(chat).unwrap_or_default().into_iter().filter(|c| c.mode != mode);
        let mine = self.all(chat).iter().filter(|c| c.mode == mode).cloned();
        let merged: Vec<DiffComment> = theirs.chain(mine).collect();
        if !merged.is_empty() {
            all.insert(chat.to_string(), merged);
        }
        let chats: serde_json::Map<String, serde_json::Value> =
            all.iter().map(|(chat, list)| (chat.clone(), list.iter().map(to_json).collect())).collect();
        file.write(&serde_json::Value::Object(chats));
    }

    pub fn all(&self, chat: &str) -> &[DiffComment] {
        self.by_chat.get(chat).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The comments written on the diff of `mode`.
    pub fn shown(&self, chat: &str, mode: ChangesMode) -> Vec<DiffComment> {
        self.all(chat).iter().filter(|c| c.mode == mode).cloned().collect()
    }

    pub fn add(&mut self, chat: &str, mode: ChangesMode, path: &str, selection: DiffSelection, body: &str, now: i64) -> String {
        // The other store may have added comments since this one loaded: never reuse its ids.
        if let Some(file) = &self.file {
            self.next_id = self.next_id.max(Self::highest_id(read_all(file).values().flatten()));
        }
        self.next_id += 1;
        let id = format!("c{}", self.next_id);
        self.by_chat.entry(chat.to_string()).or_default().push(DiffComment {
            id: id.clone(),
            path: path.to_string(),
            side: selection.side,
            start: selection.start,
            end: selection.end,
            snippet: selection.snippet,
            body: body.to_string(),
            created_at: now,
            mode,
        });
        self.save(chat, mode);
        id
    }

    pub fn update(&mut self, chat: &str, id: &str, body: &str) {
        if let Some(comment) = self.by_chat.get_mut(chat).and_then(|all| all.iter_mut().find(|c| c.id == id)) {
            comment.body = body.to_string();
            let mode = comment.mode;
            self.save(chat, mode);
        }
    }

    pub fn remove(&mut self, chat: &str, id: &str) {
        self.remove_many(chat, &[id.to_string()]);
    }

    pub fn remove_many(&mut self, chat: &str, ids: &[String]) {
        if let Some(all) = self.by_chat.get_mut(chat) {
            let modes: Vec<ChangesMode> = all.iter().filter(|c| ids.contains(&c.id)).map(|c| c.mode).collect();
            all.retain(|c| !ids.contains(&c.id));
            for mode in [ChangesMode::Uncommitted, ChangesMode::Committed, ChangesMode::Pr] {
                if modes.contains(&mode) {
                    self.save(chat, mode);
                }
            }
        }
    }

    /// Comment counts per mode and path, for the lists' badges.
    pub fn counts(&self, chat: &str) -> HashMap<(ChangesMode, String), usize> {
        let mut counts = HashMap::new();
        for comment in self.all(chat) {
            *counts.entry((comment.mode, comment.path.clone())).or_insert(0) += 1;
        }
        counts
    }
}

/// `Draft`: the rows being selected for a new comment, or those of a comment being edited. `side` is only set in
/// split.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Draft {
    pub path: String,
    pub hunk: usize,
    pub side: Option<DiffSide>,
    pub anchor: usize,
    pub head: usize,
    pub dragging: bool,
    pub editing: Option<String>,
}

impl Draft {
    pub fn lo(&self) -> usize {
        self.anchor.min(self.head)
    }

    pub fn hi(&self) -> usize {
        self.anchor.max(self.head)
    }

    /// Whether row `line` of `hunk` in `path` (in column `side`) is in the range.
    pub fn covers(&self, path: &str, hunk: usize, line: usize, side: Option<DiffSide>) -> bool {
        self.path == path && self.hunk == hunk && self.side == side && line >= self.lo() && line <= self.hi()
    }

    /// The row the editor goes under: the last of the range shown on the selected side; none while dragging.
    pub fn editor_row(&self, hunk: &DiffHunk) -> Option<usize> {
        if self.dragging {
            return None;
        }
        (self.lo()..=self.hi()).rev().find(|&ix| hunk.lines.get(ix).is_some_and(|line| self.side.is_none_or(|side| on_side(line, side))))
    }
}

/// A row a pointer is on, for the draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub path: String,
    pub hunk: usize,
    pub line: usize,
    pub side: Option<DiffSide>,
}

/// `useCommentDraft.start`: a press on a row's "+" (`extend` with Shift grows the open range instead).
pub fn start_draft(current: Option<&Draft>, target: &Target, extend: bool, drag: bool) -> Draft {
    if extend
        && let Some(current) = current
        && current.editing.is_none()
        && current.path == target.path
        && current.hunk == target.hunk
        && current.side == target.side
    {
        return Draft { head: target.line, dragging: false, ..current.clone() };
    }
    Draft {
        path: target.path.clone(),
        hunk: target.hunk,
        side: target.side,
        anchor: target.line,
        head: target.line,
        dragging: drag,
        editing: None,
    }
}

/// `useCommentDraft.over`: a drag moving over a row of the same hunk and column moves the head there.
pub fn drag_over(current: &Draft, target: &Target) -> Option<Draft> {
    (current.dragging
        && current.path == target.path
        && current.hunk == target.hunk
        && current.side == target.side
        && current.head != target.line)
        .then(|| Draft { head: target.line, ..current.clone() })
}

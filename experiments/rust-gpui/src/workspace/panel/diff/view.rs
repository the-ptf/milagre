//! [`DiffView`]: the state behind the diff (`DiffView.tsx`, `DiffFile.tsx`, `useDiffComments.ts`), its rows in a
//! virtual list, and what the owner (the Changes panel, the PR panel) gives it and hears back.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClipboardItem, Context, Entity, EventEmitter, FocusHandle, Global, ListAlignment, ListOffset, Pixels, SharedString,
    Subscription, TextLayout, Window, px,
};
use gpui_component::input::{InputEvent, TextareaState};

use super::comments::{
    ChangesMode, CommentStore, CommentView, DiffComment, DiffSelection, DiffSide, Draft, MessageScope, Target, drag_over,
    format_comments_message, locate_comment, selection_from_rows, start_draft,
};
use super::highlight::{HunkHighlighter, Runs, syntax_for};
use super::rows::{Body, DiffLayout, FileRows, Row, diff_ranges, file_rows};
use crate::logic::diff::git::{DiffFileEntry, DiffFileResult};
use crate::logic::diff::{DiffHunk, LineKind, Range as Utf16Range, parse_patch, split_rows, word_changes};
use crate::ui::TextArea;

/// `LARGE_DIFF_LINES`: a file with more changed lines waits for "Show diff".
pub const LARGE_DIFF_LINES: u32 = 3000;
/// Rows past the screen whose files load (the desktop loads files within 800px of the viewport).
const LOAD_MARGIN: usize = 60;
/// Hunks this long are highlighted in the frame that first draws them (TypeScript costs about 0.25 ms a line in
/// syntect, Rust 0.07); longer ones parse in the background.
const SYNC_HIGHLIGHT_LINES: usize = 120;
/// Lines a background parse hands back at a time.
const BACKGROUND_CHUNK: usize = 400;
/// A row's height before it is measured.
pub(super) const ROW_ESTIMATE: f32 = 20.0;

/// Unified/Split and Wrap, shared by every diff in the app for the session (the desktop keeps them across launches
/// under `milagre:diff-layout` and `milagre:diff-wrap`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiffPrefs {
    pub layout: DiffLayout,
    pub wrap: bool,
}

impl Global for DiffPrefs {}

impl DiffPrefs {
    pub fn get(cx: &App) -> Self {
        cx.try_global::<Self>().copied().unwrap_or_default()
    }
}

/// Reads a file's patch (`git:diff-file`, `pr:diff-file`); the fixture answers at once.
pub type Loader = Rc<dyn Fn(&DiffFileEntry) -> Option<DiffFileResult>>;

/// What the owner shows in the diff.
#[derive(Clone)]
pub struct DiffSource {
    /// The Chat whose comments these are.
    pub chat: SharedString,
    pub mode: ChangesMode,
    /// The base the committed changes are against, for the message (`main`, `PR #412`).
    pub base: Option<String>,
    pub files: Vec<DiffFileEntry>,
    pub loader: Loader,
    /// Where Back goes ("Back to <Chat>").
    pub back_label: SharedString,
    /// A PR's diff: the editor can add to the review, and the list leaves room for the review bar.
    pub review: bool,
    /// Whether rows take line comments (a commit's files are read-only).
    pub comments: bool,
}

/// A PR review thread, where GitHub anchors it: RIGHT threads on a new line number, LEFT ones on an old one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadAnchor {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub side: DiffSide,
}

/// Draws a group of threads by id (the PR panel's cards).
pub type ThreadRenderer = Rc<dyn Fn(&[String], &mut Window, &mut App) -> AnyElement>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffEvent {
    /// Back: close the diff.
    Close,
    Refresh,
    /// "Send N comments": the message for the Chat. The comments are removed once sent, as the desktop does.
    Send(String),
    /// The editor's "Add to review" on a PR's diff.
    AddToReview {
        path: String,
        selection: DiffSelection,
        body: String,
    },
    /// The file whose header is pinned at the top (or held) changed: the file lists mark it.
    VisibleFile(Option<String>),
}

pub(super) struct Loaded {
    pub hunks: Vec<DiffHunk>,
    pub binary: bool,
    pub too_large: bool,
}

pub(super) enum Patch {
    Unloaded,
    Ready(Rc<Loaded>),
    Error(String),
}

pub(super) struct FileState {
    pub entry: DiffFileEntry,
    pub patch: Patch,
    pub collapsed: bool,
    /// "Show diff" on a large file.
    pub forced: bool,
    /// Comment ids under each (hunk, line), and the outdated ones.
    pub placed: HashMap<(usize, usize), Vec<String>>,
    pub stale: Vec<String>,
    /// Thread ids under each (hunk, line), and the ones no row carries.
    pub threads: HashMap<(usize, usize), Vec<String>>,
    pub loose: Vec<String>,
}

impl FileState {
    pub fn is_large(&self) -> bool {
        self.entry.added + self.entry.removed > LARGE_DIFF_LINES
    }

    pub fn loaded(&self) -> Option<&Rc<Loaded>> {
        match &self.patch {
            Patch::Ready(loaded) => Some(loaded),
            _ => None,
        }
    }

    /// The hunks, when the file shows rows.
    pub fn hunks(&self) -> Option<&[DiffHunk]> {
        self.loaded().filter(|l| !l.binary && !l.too_large && !self.entry.binary && !l.hunks.is_empty()).map(|l| l.hunks.as_slice())
    }

    /// What the file says instead of rows, if anything (the button is "Show diff" on a large one).
    pub fn message(&self) -> Option<String> {
        if self.entry.binary {
            return Some("Binary file".into());
        }
        match &self.patch {
            Patch::Unloaded if self.is_large() && !self.forced => Some("This diff is large".into()),
            Patch::Unloaded => Some("Loading\u{2026}".into()),
            Patch::Error(message) => Some(message.clone()),
            Patch::Ready(l) if l.binary => Some("Binary file".into()),
            Patch::Ready(l) if l.too_large => Some("This file's diff is too large to show".into()),
            Patch::Ready(l) if l.hunks.is_empty() => Some(match &self.entry.old_path {
                Some(old) if self.entry.status == crate::logic::diff::git::DiffStatus::Renamed => format!("Renamed from {old}"),
                _ => "No content changes".into(),
            }),
            Patch::Ready(_) => None,
        }
    }

    /// Waits for "Show diff".
    pub fn waits_for_show(&self) -> bool {
        matches!(self.patch, Patch::Unloaded) && self.is_large() && !self.forced && !self.entry.binary
    }
}

/// A hunk's syntax runs by line, as far as parsed.
pub(super) type HunkRuns = Vec<Option<Runs>>;
/// A hunk's changed-word ranges (UTF-16) by line.
pub(super) type HunkWords = Vec<Option<Vec<Utf16Range>>>;

/// One end of a code selection: a row, which half of a split row (0 left or unified, 1 right), a byte offset.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CodePoint {
    pub row: usize,
    pub half: u8,
    pub offset: usize,
}

/// Text selected in the code (only one column of a split view, as the comment ranges are).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodeSelection {
    pub anchor: CodePoint,
    pub head: CodePoint,
    pub dragging: bool,
}

impl CodeSelection {
    pub fn ordered(&self) -> (CodePoint, CodePoint) {
        let key = |p: &CodePoint| (p.row, p.offset);
        if key(&self.anchor) <= key(&self.head) { (self.anchor, self.head) } else { (self.head, self.anchor) }
    }

    /// The selected byte range of row `row`'s text in half `half`, if any of it is.
    pub fn range_in(&self, row: usize, half: u8, len: usize) -> Option<Range<usize>> {
        if half != self.anchor.half {
            return None;
        }
        let (lo, hi) = self.ordered();
        if row < lo.row || row > hi.row {
            return None;
        }
        let start = if row == lo.row { lo.offset.min(len) } else { 0 };
        let end = if row == hi.row { hi.offset.min(len) } else { len };
        (start < end || (row != hi.row && len == 0)).then_some(start..end)
    }
}

/// What the tests and the timing read back.
#[derive(Clone, Copy, Debug, Default)]
pub struct DiffStats {
    pub row_renders: usize,
    pub loads: usize,
    /// Syntax-run lookups (a row drawn asks for its runs; parsing happens only for rows not parsed before).
    pub highlighted_lines: usize,
}

pub struct DiffView {
    pub(super) source: Option<DiffSource>,
    pub(super) files: Vec<FileState>,
    pub(super) rows: Vec<Row>,
    /// Each file's rows: `rows[file_ranges[f].clone()]`.
    pub(super) file_ranges: Vec<Range<usize>>,
    pub(super) list: gpui::ListState,
    pub(super) applied: DiffPrefs,
    pub(super) comments: CommentStore,
    pub(super) draft: Option<Draft>,
    pub(super) editor: Option<Entity<TextareaState>>,
    _editor_sub: Option<Subscription>,
    pub(super) expanded_comments: HashSet<String>,
    pub(super) selection: Option<CodeSelection>,
    /// The text layout of each code cell drawn this frame, by (row, half), for pointer to offset.
    pub(super) layouts: RefCell<HashMap<(usize, u8), TextLayout>>,
    pub(super) scroll_x: Pixels,
    pub(super) char_width: Option<Pixels>,
    pub(super) widest: usize,
    /// The file the open scrolled to, kept at the top until the reader scrolls.
    pub(super) holding: Option<usize>,
    pub(super) held_top: Option<ListOffset>,
    pub(super) visible: Option<usize>,
    pub(super) threads: Vec<ThreadAnchor>,
    pub(super) thread_renderer: Option<ThreadRenderer>,
    /// Syntax runs per (file, hunk), by hunk line, filled as they are parsed; `None` for a plain file.
    pub(super) styles: RefCell<HashMap<(usize, usize), Option<HunkRuns>>>,
    /// Hunks too long to parse in a frame, waiting for a background parse to start.
    pub(super) wanted: RefCell<Vec<(usize, usize)>>,
    /// Bumped whenever the patches change, so a parse of the old ones is dropped.
    pub(super) epoch: u64,
    pub(super) words: RefCell<HashMap<(usize, usize), Rc<HunkWords>>>,
    pub(super) focus: FocusHandle,
    pub(super) stats: std::cell::Cell<DiffStats>,
    pub(super) seeded: bool,
    /// Shown over the Chat column (`over_chat.rs`): Back's label (the Chat's title) and the bar's insets.
    pub(super) over_chat: Option<super::over_chat::OverChat>,
}

impl EventEmitter<DiffEvent> for DiffView {}

impl DiffView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        super::install_keys(cx);
        Self {
            source: None,
            files: Vec::new(),
            rows: Vec::new(),
            file_ranges: Vec::new(),
            list: gpui::ListState::new(0, ListAlignment::Top, px(400.0)),
            applied: DiffPrefs::get(cx),
            comments: CommentStore::default(),
            draft: None,
            editor: None,
            _editor_sub: None,
            expanded_comments: HashSet::new(),
            selection: None,
            layouts: RefCell::new(HashMap::new()),
            scroll_x: px(0.0),
            char_width: None,
            widest: 0,
            holding: None,
            held_top: None,
            visible: None,
            threads: Vec::new(),
            thread_renderer: None,
            styles: RefCell::new(HashMap::new()),
            wanted: RefCell::new(Vec::new()),
            epoch: 0,
            words: RefCell::new(HashMap::new()),
            focus: cx.focus_handle(),
            stats: std::cell::Cell::new(DiffStats::default()),
            seeded: false,
            over_chat: None,
        }
    }

    // --- reading -----------------------------------------------------------------------------------------------

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn list_state(&self) -> &gpui::ListState {
        &self.list
    }

    pub fn stats(&self) -> DiffStats {
        self.stats.get()
    }

    pub fn draft(&self) -> Option<&Draft> {
        self.draft.as_ref()
    }

    pub fn selection(&self) -> Option<CodeSelection> {
        self.selection
    }

    pub fn source(&self) -> Option<&DiffSource> {
        self.source.as_ref()
    }

    pub fn holding(&self) -> Option<&str> {
        self.holding.and_then(|f| self.files.get(f)).map(|f| f.entry.path.as_str())
    }

    pub fn visible_path(&self) -> Option<&str> {
        self.visible.and_then(|f| self.files.get(f)).map(|f| f.entry.path.as_str())
    }

    pub fn is_collapsed(&self, path: &str) -> bool {
        self.files.iter().any(|f| f.entry.path == path && f.collapsed)
    }

    pub fn is_loaded(&self, path: &str) -> bool {
        self.files.iter().any(|f| f.entry.path == path && f.loaded().is_some())
    }

    pub fn file_range(&self, path: &str) -> Option<Range<usize>> {
        self.files.iter().position(|f| f.entry.path == path).map(|f| self.file_ranges[f].clone())
    }

    pub(super) fn chat(&self) -> &str {
        self.source.as_ref().map(|s| s.chat.as_ref()).unwrap_or("")
    }

    pub(super) fn mode(&self) -> ChangesMode {
        self.source.as_ref().map(|s| s.mode).unwrap_or_default()
    }

    /// The shown diff's comments with their outdated flag: their file left the list, or their rows changed.
    pub fn comment_views(&self) -> Vec<CommentView> {
        self.comments
            .shown(self.chat(), self.mode())
            .into_iter()
            .map(|comment| {
                let outdated = match self.files.iter().find(|f| f.entry.path == comment.path) {
                    None => self.source.is_some(),
                    Some(file) => match file.loaded() {
                        Some(loaded) => locate_comment(&comment, &loaded.hunks).is_none(),
                        None => false,
                    },
                };
                CommentView { comment, outdated }
            })
            .collect()
    }

    pub(super) fn comment_view(&self, id: &str) -> Option<CommentView> {
        self.comment_views().into_iter().find(|c| c.comment.id == id)
    }

    /// The comments "Send" would send: every one that still matches the diff.
    pub fn sendable(&self) -> Vec<DiffComment> {
        self.comment_views().into_iter().filter(|c| !c.outdated).map(|c| c.comment).collect()
    }

    /// Comments whose file is not in the diff.
    pub(super) fn orphans(&self) -> Vec<String> {
        let paths: HashSet<&str> = self.files.iter().map(|f| f.entry.path.as_str()).collect();
        self.comments.shown(self.chat(), self.mode()).into_iter().filter(|c| !paths.contains(c.path.as_str())).map(|c| c.id).collect()
    }

    pub fn comment_store(&self) -> &CommentStore {
        &self.comments
    }

    // --- the source --------------------------------------------------------------------------------------------

    /// Shows `source`, scrolled to `target`'s file and holding it there while the files around it load.
    pub fn set_source(&mut self, source: DiffSource, target: Option<&str>, cx: &mut Context<Self>) {
        let same = self.source.as_ref().is_some_and(|old| {
            old.chat == source.chat && old.mode == source.mode && old.files == source.files && old.review == source.review
        });
        if !same {
            self.files = source
                .files
                .iter()
                .map(|entry| FileState {
                    entry: entry.clone(),
                    patch: Patch::Unloaded,
                    collapsed: false,
                    forced: false,
                    placed: HashMap::new(),
                    stale: Vec::new(),
                    threads: HashMap::new(),
                    loose: Vec::new(),
                })
                .collect();
            self.styles.borrow_mut().clear();
            self.epoch += 1;
            self.words.borrow_mut().clear();
            self.draft = None;
            self.editor = None;
            self._editor_sub = None;
            self.selection = None;
            self.scroll_x = px(0.0);
        }
        let reread = same && self.source.as_ref().is_some_and(|old| !Rc::ptr_eq(&old.loader, &source.loader));
        if reread {
            // New patches for the same files (a refresh): read them again, keep the folds.
            for file in &mut self.files {
                file.patch = Patch::Unloaded;
            }
            self.styles.borrow_mut().clear();
            self.epoch += 1;
            self.words.borrow_mut().clear();
            self.draft = None;
            self.editor = None;
            self._editor_sub = None;
            self.selection = None;
        }
        self.source = Some(source);
        // Commented files are judged against their patch, even far from the screen.
        let commented: HashSet<String> = self.comments.shown(self.chat(), self.mode()).into_iter().map(|c| c.path).collect();
        for f in 0..self.files.len() {
            if commented.contains(&self.files[f].entry.path) {
                self.load(f);
            }
        }
        let target = target.and_then(|path| self.files.iter().position(|f| f.entry.path == path));
        if let Some(f) = target {
            self.load(f);
        }
        self.rebuild_all();
        match target {
            Some(f) => self.scroll_to_file(f),
            None if !same => self.list.scroll_to(ListOffset::default()),
            None => {}
        }
        self.holding = target;
        self.load_near(cx);
        self.set_visible(target.or(if self.files.is_empty() { None } else { Some(0) }), cx);
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.source = None;
        self.files.clear();
        self.rows.clear();
        self.file_ranges.clear();
        self.list.reset(0);
        self.draft = None;
        self.editor = None;
        self.selection = None;
        self.holding = None;
        self.visible = None;
        cx.notify();
    }

    /// The PR's threads, and how to draw them. Called again whenever they change (a reply, a fold).
    pub fn set_threads(&mut self, threads: Vec<ThreadAnchor>, renderer: Option<ThreadRenderer>, cx: &mut Context<Self>) {
        self.thread_renderer = renderer;
        if self.threads != threads {
            self.threads = threads;
            self.rebuild_files(0..self.files.len());
        }
        // A thread card's height changes as it folds or takes a reply.
        for (ix, row) in self.rows.iter().enumerate() {
            if matches!(row, Row::Threads { .. } | Row::Loose { .. }) {
                self.list.remeasure_items(ix..ix + 1);
            }
        }
        cx.notify();
    }

    /// Takes the session's Unified/Split and Wrap if another diff changed them.
    pub(super) fn sync_prefs(&mut self, cx: &mut Context<Self>) {
        let prefs = DiffPrefs::get(cx);
        if prefs == self.applied {
            return;
        }
        let layout_changed = prefs.layout != self.applied.layout;
        self.applied = prefs;
        if layout_changed {
            // The rows a draft points at mean something else in the other layout.
            self.draft = None;
            self.editor = None;
            self.selection = None;
            let top = self.list.logical_scroll_top();
            let place = self.rows.get(top.item_ix).and_then(|row| row.place().map(|p| (p, *row)));
            let file = self.rows.get(top.item_ix).and_then(|r| r.file());
            self.rebuild_all();
            let target = place
                .and_then(|((file, hunk, line), _)| {
                    self.rows.iter().position(|row| match (row.place(), line) {
                        (Some((f, h, Some(l))), Some(want)) => {
                            f == file && h == hunk && (l == want || matches!(row, Row::Split { left: Some(x), .. } if *x == want))
                        }
                        (Some((f, h, None)), None) => f == file && h == hunk,
                        _ => false,
                    })
                })
                .or_else(|| file.map(|f| self.file_ranges[f].start));
            if let Some(ix) = target {
                self.list.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.0) });
            }
        } else {
            self.list.remeasure();
        }
        if prefs.wrap || prefs.layout == DiffLayout::Split {
            self.scroll_x = px(0.0);
        }
    }

    pub fn set_layout(&mut self, layout: DiffLayout, cx: &mut Context<Self>) {
        let prefs = DiffPrefs { layout, ..DiffPrefs::get(cx) };
        cx.set_global(prefs);
        self.sync_prefs(cx);
        cx.notify();
    }

    pub fn set_wrap(&mut self, wrap: bool, cx: &mut Context<Self>) {
        let prefs = DiffPrefs { wrap, ..DiffPrefs::get(cx) };
        cx.set_global(prefs);
        self.sync_prefs(cx);
        cx.notify();
    }

    pub fn layout(&self) -> DiffLayout {
        self.applied.layout
    }

    pub fn wrap(&self) -> bool {
        self.applied.wrap
    }

    // --- rows --------------------------------------------------------------------------------------------------

    fn rows_for(&self, f: usize) -> Vec<Row> {
        let file = &self.files[f];
        let mut slots: HashSet<(usize, usize)> = file.placed.keys().copied().collect();
        if let (Some(draft), Some(hunks)) = (&self.draft, file.hunks())
            && draft.path == file.entry.path
            && let Some(row) = hunks.get(draft.hunk).and_then(|hunk| draft.editor_row(hunk))
        {
            slots.insert((draft.hunk, row));
        }
        let threads: HashSet<(usize, usize)> = file.threads.keys().copied().collect();
        let body = match file.hunks() {
            Some(hunks) => Body::Hunks(hunks),
            None => Body::Message,
        };
        file_rows(&FileRows {
            file: f,
            collapsed: file.collapsed,
            layout: self.applied.layout,
            body,
            slots: &slots,
            threads: &threads,
            stale: !file.stale.is_empty(),
            loose: !file.loose.is_empty(),
        })
    }

    /// Where each comment and thread of file `f` sits now.
    fn place_file(&mut self, f: usize) {
        let views = self.comment_views();
        let editing = self.draft.as_ref().and_then(|d| d.editing.clone());
        let threads = self.threads.clone();
        let file = &mut self.files[f];
        file.placed.clear();
        file.stale.clear();
        file.threads.clear();
        file.loose.clear();
        let hunks: &[DiffHunk] = file.loaded().map(|l| l.hunks.as_slice()).unwrap_or(&[]);
        let hunks = hunks.to_vec();
        for view in views.iter().filter(|v| v.comment.path == file.entry.path) {
            if file.loaded().is_none() {
                continue;
            }
            match (!view.outdated).then(|| locate_comment(&view.comment, &hunks)).flatten() {
                Some(found) => {
                    if editing.as_deref() == Some(view.comment.id.as_str()) {
                        continue;
                    }
                    let last = *found.lines.last().unwrap_or(&0);
                    file.placed.entry((found.hunk, last)).or_default().push(view.comment.id.clone());
                }
                None => file.stale.push(view.comment.id.clone()),
            }
        }
        if !hunks.is_empty() {
            for thread in threads.iter().filter(|t| t.path == file.entry.path) {
                let at = thread.line.and_then(|n| {
                    hunks.iter().enumerate().find_map(|(h, hunk)| {
                        hunk.lines
                            .iter()
                            .position(|line| match thread.side {
                                DiffSide::New => line.kind != LineKind::Remove && line.new_number == Some(n),
                                DiffSide::Old => line.kind != LineKind::Add && line.old_number == Some(n),
                            })
                            .map(|l| (h, l))
                    })
                });
                match at {
                    Some(at) => file.threads.entry(at).or_default().push(thread.id.clone()),
                    None => file.loose.push(thread.id.clone()),
                }
            }
        }
    }

    /// Every row from scratch (a new source, another layout).
    pub(super) fn rebuild_all(&mut self) {
        for f in 0..self.files.len() {
            self.place_file(f);
        }
        let mut rows = Vec::new();
        if !self.orphans().is_empty() {
            rows.push(Row::Orphans);
        }
        self.file_ranges.clear();
        for f in 0..self.files.len() {
            let start = rows.len();
            rows.extend(self.rows_for(f));
            self.file_ranges.push(start..rows.len());
        }
        rows.push(Row::Tail);
        // Keep the place: the same row index (a comment slot more or less above it moves it by a row at most).
        let top = self.list.logical_scroll_top();
        self.rows = rows;
        self.list.reset(self.rows.len());
        if top.item_ix > 0 || top.offset_in_item > px(0.0) {
            self.list
                .scroll_to(ListOffset { item_ix: top.item_ix.min(self.rows.len().saturating_sub(1)), offset_in_item: top.offset_in_item });
        }
        self.selection = None;
        self.recompute_widest();
    }

    /// Rebuilds the rows of the files in `files` and splices only what changed into the list.
    pub(super) fn rebuild_files(&mut self, files: Range<usize>) {
        for f in files.clone() {
            self.place_file(f);
        }
        let mut new_rows = Vec::with_capacity(self.rows.len());
        let orphans = !self.orphans().is_empty();
        if orphans {
            new_rows.push(Row::Orphans);
        }
        let mut ranges = Vec::with_capacity(self.files.len());
        for f in 0..self.files.len() {
            let start = new_rows.len();
            if files.contains(&f) {
                new_rows.extend(self.rows_for(f));
            } else {
                new_rows.extend_from_slice(&self.rows[self.file_ranges[f].clone()]);
            }
            ranges.push(start..new_rows.len());
        }
        new_rows.push(Row::Tail);
        if let Some((old, new)) = diff_ranges(&self.rows, &new_rows) {
            self.list.splice(old, new.len());
            self.selection = None;
        }
        // Rows after a change keep their kind but may draw a different comment or thread: measure the touched files again.
        for f in files {
            let range = ranges[f].clone();
            if !range.is_empty() {
                self.list.remeasure_items(range);
            }
        }
        self.rows = new_rows;
        self.file_ranges = ranges;
        self.recompute_widest();
    }

    fn rebuild_path(&mut self, path: &str) {
        if let Some(f) = self.files.iter().position(|f| f.entry.path == path) {
            self.rebuild_files(f..f + 1);
        } else {
            self.rebuild_files(0..0);
        }
    }

    fn recompute_widest(&mut self) {
        self.widest = self
            .files
            .iter()
            .filter(|f| !f.collapsed)
            .filter_map(|f| f.hunks())
            .flat_map(|hunks| hunks.iter().flat_map(|h| h.lines.iter()))
            .map(|line| line.text.chars().count())
            .max()
            .unwrap_or(0);
    }

    fn scroll_to_file(&mut self, f: usize) {
        if let Some(range) = self.file_ranges.get(f) {
            let top = ListOffset { item_ix: range.start, offset_in_item: px(0.0) };
            self.list.scroll_to(top);
            self.held_top = Some(top);
        }
    }

    // --- loading -----------------------------------------------------------------------------------------------

    /// Reads file `f`'s patch if it has none. Large files wait for "Show diff"; binary ones never load.
    fn load(&mut self, f: usize) -> bool {
        let Some(source) = self.source.clone() else { return false };
        let file = &mut self.files[f];
        if !matches!(file.patch, Patch::Unloaded) || file.entry.binary || (file.is_large() && !file.forced) {
            return false;
        }
        file.patch = match (source.loader)(&file.entry) {
            Some(result) => {
                Patch::Ready(Rc::new(Loaded { hunks: parse_patch(&result.patch), binary: result.binary, too_large: result.too_large }))
            }
            None => Patch::Error("There is no diff to show for this file.".into()),
        };
        let mut stats = self.stats.get();
        stats.loads += 1;
        self.stats.set(stats);
        true
    }

    /// Loads the files whose rows are on screen or near it.
    pub(super) fn load_near(&mut self, _cx: &mut Context<Self>) {
        if self.files.is_empty() {
            return;
        }
        // Anything that moved the list since the hold set it (a wheel, the scrollbar, code) lets go of the file.
        if self.held_top.is_some_and(|held| held != self.list.logical_scroll_top()) {
            self.release_hold();
        }
        let top = self.list.logical_scroll_top().item_ix;
        let height = self.list.viewport_bounds().size.height.max(px(900.0));
        let span = (f32::from(height) / ROW_ESTIMATE).ceil() as usize;
        let window = top.saturating_sub(LOAD_MARGIN)..(top + span + LOAD_MARGIN).min(self.rows.len());
        let mut changed = Vec::new();
        for f in 0..self.files.len() {
            let range = &self.file_ranges[f];
            if range.start < window.end && range.end > window.start && self.load(f) {
                changed.push(f);
            }
        }
        if let (Some(first), Some(last)) = (changed.first(), changed.last()) {
            self.rebuild_files(*first..*last + 1);
            // Files that grew push the screen's rows further; load what came into the window behind them.
            let top = self.list.logical_scroll_top().item_ix;
            let window = top.saturating_sub(LOAD_MARGIN)..(top + span + LOAD_MARGIN).min(self.rows.len());
            let more: Vec<usize> = (0..self.files.len())
                .filter(|&f| self.file_ranges[f].start < window.end && self.file_ranges[f].end > window.start)
                .collect();
            let mut again = Vec::new();
            for f in more {
                if self.load(f) {
                    again.push(f);
                }
            }
            if let (Some(first), Some(last)) = (again.first(), again.last()) {
                self.rebuild_files(*first..*last + 1);
            }
        }
        if let Some(f) = self.holding {
            // Rows above the held header changed: keep it the top row.
            let held = ListOffset { item_ix: self.file_ranges[f].start, offset_in_item: px(0.0) };
            if self.list.logical_scroll_top() != held {
                self.list.scroll_to(held);
            }
            self.held_top = Some(held);
        }
    }

    pub fn show_large(&mut self, path: &str, cx: &mut Context<Self>) {
        if let Some(f) = self.files.iter().position(|f| f.entry.path == path) {
            self.files[f].forced = true;
            self.load(f);
            self.rebuild_files(f..f + 1);
            cx.notify();
        }
    }

    pub fn toggle_collapsed(&mut self, path: &str, cx: &mut Context<Self>) {
        if let Some(f) = self.files.iter().position(|f| f.entry.path == path) {
            self.files[f].collapsed = !self.files[f].collapsed;
            self.rebuild_files(f..f + 1);
            cx.notify();
        }
    }

    // --- scrolling ---------------------------------------------------------------------------------------------

    /// The reader scrolled: the held file is let go.
    pub(super) fn release_hold(&mut self) {
        self.holding = None;
        self.held_top = None;
    }

    pub(super) fn set_visible(&mut self, file: Option<usize>, cx: &mut Context<Self>) {
        if self.visible != file {
            self.visible = file;
            let path = file.and_then(|f| self.files.get(f)).map(|f| f.entry.path.clone());
            cx.emit(DiffEvent::VisibleFile(path));
        }
    }

    pub(super) fn max_scroll_x(&self, viewport: Pixels) -> Pixels {
        let Some(char_width) = self.char_width else { return px(0.0) };
        let content = char_width * self.widest as f32 + px(super::render::GUTTER_W * 2.0 + super::render::MARKER_W + 12.0);
        (content - viewport + px(super::render::CARD_INSET * 2.0 + 2.0)).max(px(0.0))
    }

    // --- comments ----------------------------------------------------------------------------------------------

    /// A press on a row's "+": a new range there (Shift grows the open one), dragged until the button comes up.
    pub fn start_comment(&mut self, target: Target, extend: bool, drag: bool, window: &mut Window, cx: &mut Context<Self>) {
        let previous = self.draft.as_ref().map(|d| d.path.clone());
        let next = start_draft(self.draft.as_ref(), &target, extend, drag);
        let fresh = self.draft.as_ref().is_none_or(|d| d.anchor != next.anchor || d.hunk != next.hunk || d.path != next.path);
        self.draft = Some(next);
        if fresh {
            self.editor = None;
            self._editor_sub = None;
        }
        if !drag {
            self.ensure_editor(String::new(), window, cx);
        }
        if let Some(previous) = previous.filter(|p| *p != target.path) {
            self.rebuild_path(&previous);
        }
        self.rebuild_path(&target.path);
        cx.notify();
    }

    /// The pointer is over a row while a range is dragged.
    pub fn drag_comment(&mut self, target: Target, cx: &mut Context<Self>) {
        if let Some(next) = self.draft.as_ref().and_then(|d| drag_over(d, &target)) {
            self.draft = Some(next);
            cx.notify();
        }
    }

    /// The button came up: the editor opens under the range.
    pub fn finish_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(draft) = self.draft.as_mut().filter(|d| d.dragging) else { return };
        draft.dragging = false;
        let path = draft.path.clone();
        self.ensure_editor(String::new(), window, cx);
        self.rebuild_path(&path);
        cx.notify();
    }

    fn ensure_editor(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.editor.is_none() {
            let state = TextArea::state("Leave a comment", (3, 12), window, cx);
            if !text.is_empty() {
                state.update(cx, |state, cx| state.set_value(text, window, cx));
            }
            let sub = cx.subscribe_in(&state, window, |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { secondary: true, .. } => this.save_comment(window, cx),
                InputEvent::Change => this.remeasure_editor(),
                _ => {}
            });
            self.editor = Some(state);
            self._editor_sub = Some(sub);
        }
        if let Some(editor) = &self.editor {
            let handle = gpui::Focusable::focus_handle(editor.read(cx), cx);
            window.focus(&handle, cx);
        }
    }

    fn remeasure_editor(&self) {
        if let Some(ix) = self.rows.iter().position(|row| self.editor_at(*row)) {
            self.list.remeasure_items(ix..ix + 1);
        }
    }

    /// Whether the editor sits in this row (a slot under the draft's last row).
    pub(super) fn editor_at(&self, row: Row) -> bool {
        let (Row::Slot { file, hunk, line }, Some(draft)) = (row, &self.draft) else { return false };
        let Some(state) = self.files.get(file) else { return false };
        draft.path == state.entry.path
            && draft.hunk == hunk
            && state.hunks().and_then(|hunks| hunks.get(hunk)).and_then(|h| draft.editor_row(h)) == Some(line)
    }

    pub fn editor_text(&self, cx: &App) -> String {
        self.editor.as_ref().map(|e| e.read(cx).value().to_string()).unwrap_or_default()
    }

    pub fn set_editor_text(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(editor) = &self.editor {
            editor.update(cx, |state, cx| state.set_value(text.to_string(), window, cx));
        }
    }

    pub fn cancel_comment(&mut self, cx: &mut Context<Self>) {
        let path = self.draft.take().map(|d| d.path);
        self.editor = None;
        self._editor_sub = None;
        if let Some(path) = path {
            self.rebuild_path(&path);
        }
        cx.notify();
    }

    fn draft_selection(&self) -> Option<(String, DiffSelection)> {
        let draft = self.draft.as_ref()?;
        let file = self.files.iter().find(|f| f.entry.path == draft.path)?;
        let hunk = file.hunks()?.get(draft.hunk)?;
        Some((draft.path.clone(), selection_from_rows(hunk, draft.anchor, draft.head, draft.side)?))
    }

    /// Comment (or Save, for an edit): kept for the Chat.
    pub fn save_comment(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = window;
        let body = self.editor_text(cx).trim().to_string();
        if body.is_empty() {
            return;
        }
        let chat = self.chat().to_string();
        let mode = self.mode();
        match self.draft.as_ref().and_then(|d| d.editing.clone()) {
            Some(id) => self.comments.update(&chat, &id, &body),
            None => {
                if let Some((path, selection)) = self.draft_selection() {
                    self.comments.add(&chat, mode, &path, selection, &body, crate::workspace::panel::pr::model::now_ms());
                }
            }
        }
        self.after_comment_change(cx);
    }

    /// "Add to review" on a PR's diff: the owner writes it to GitHub.
    pub fn add_to_review(&mut self, cx: &mut Context<Self>) {
        let body = self.editor_text(cx).trim().to_string();
        if body.is_empty() {
            return;
        }
        if let Some((path, selection)) = self.draft_selection() {
            cx.emit(DiffEvent::AddToReview { path, selection, body });
        }
        self.cancel_comment(cx);
    }

    fn after_comment_change(&mut self, cx: &mut Context<Self>) {
        let path = self.draft.take().map(|d| d.path);
        self.editor = None;
        self._editor_sub = None;
        let had_orphans = self.rows.first() == Some(&Row::Orphans);
        if had_orphans != !self.orphans().is_empty() {
            self.rebuild_all();
        } else if let Some(path) = path {
            self.rebuild_path(&path);
        } else {
            self.rebuild_files(0..self.files.len());
        }
        cx.notify();
    }

    pub fn delete_comment(&mut self, id: &str, cx: &mut Context<Self>) {
        let chat = self.chat().to_string();
        let path = self.comments.all(&chat).iter().find(|c| c.id == id).map(|c| c.path.clone());
        self.comments.remove(&chat, id);
        if let Some(path) = path {
            self.draft = None;
            self.editor = None;
            self._editor_sub = None;
            let had_orphans = self.rows.first() == Some(&Row::Orphans);
            if had_orphans != !self.orphans().is_empty() {
                self.rebuild_all();
            } else {
                self.rebuild_path(&path);
            }
        }
        cx.notify();
    }

    /// Edit on a card: its rows become the draft again, with its text.
    pub fn edit_comment(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(view) = self.comment_view(id) else { return };
        let Some(file) = self.files.iter().find(|f| f.entry.path == view.comment.path) else { return };
        let Some(found) = file.loaded().and_then(|l| locate_comment(&view.comment, &l.hunks)) else { return };
        let (Some(&anchor), Some(&head)) = (found.lines.first(), found.lines.last()) else { return };
        let side = (self.applied.layout == DiffLayout::Split).then_some(view.comment.side);
        self.draft = Some(Draft {
            path: view.comment.path.clone(),
            hunk: found.hunk,
            side,
            anchor,
            head,
            dragging: false,
            editing: Some(id.to_string()),
        });
        self.editor = None;
        self._editor_sub = None;
        self.ensure_editor(view.comment.body.clone(), window, cx);
        self.rebuild_path(&view.comment.path);
        cx.notify();
    }

    pub fn toggle_comment_expanded(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.expanded_comments.remove(id) {
            self.expanded_comments.insert(id.to_string());
        }
        if let Some(ix) = self
            .rows
            .iter()
            .position(|row| matches!(row, Row::Slot { .. } | Row::Stale { .. } | Row::Orphans) && self.row_has_comment(*row, id))
        {
            self.list.remeasure_items(ix..ix + 1);
        }
        cx.notify();
    }

    fn row_has_comment(&self, row: Row, id: &str) -> bool {
        match row {
            Row::Slot { file, hunk, line } => self.files[file].placed.get(&(hunk, line)).is_some_and(|ids| ids.iter().any(|c| c == id)),
            Row::Stale { file } => self.files[file].stale.iter().any(|c| c == id),
            Row::Orphans => self.orphans().iter().any(|c| c == id),
            _ => false,
        }
    }

    /// "Send N comments": one message with every comment that still matches; they leave the store once sent.
    pub fn send_comments(&mut self, cx: &mut Context<Self>) {
        let sent = self.sendable();
        if sent.is_empty() {
            return;
        }
        let source = self.source.as_ref();
        let scope = if self.mode() == ChangesMode::Uncommitted { MessageScope::Uncommitted } else { MessageScope::Committed };
        let message = format_comments_message(&sent, scope, source.and_then(|s| s.base.as_deref()));
        let chat = self.chat().to_string();
        self.comments.remove_many(&chat, &sent.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
        self.draft = None;
        self.editor = None;
        self.rebuild_all();
        cx.emit(DiffEvent::Send(message));
        cx.notify();
    }

    /// Seeds a comment (snapshots and tests): on rows `from..=to` of hunk `hunk` of `path`.
    #[allow(clippy::too_many_arguments)]
    pub fn seed_comment(
        &mut self,
        path: &str,
        hunk: usize,
        from: usize,
        to: usize,
        side: Option<DiffSide>,
        body: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(f) = self.files.iter().position(|f| f.entry.path == path) else { return };
        self.load(f);
        let Some(selection) = self.files[f].hunks().and_then(|h| h.get(hunk)).and_then(|h| selection_from_rows(h, from, to, side)) else {
            return;
        };
        let chat = self.chat().to_string();
        self.comments.add(&chat, self.mode(), path, selection, body, 0);
        self.rebuild_all();
        cx.notify();
    }

    /// Adds a comment as written earlier, whatever the diff holds now (an outdated one, for snapshots and tests).
    pub fn seed_raw_comment(&mut self, comment: DiffComment, cx: &mut Context<Self>) {
        let chat = self.chat().to_string();
        let mode = self.mode();
        self.comments.add(
            &chat,
            mode,
            &comment.path,
            DiffSelection { side: comment.side, start: comment.start, end: comment.end, snippet: comment.snippet },
            &comment.body,
            0,
        );
        self.rebuild_all();
        cx.notify();
    }

    // --- code selection ----------------------------------------------------------------------------------------

    /// The text a code cell shows: its line's text.
    pub(super) fn cell_text(&self, row: usize, half: u8) -> Option<&str> {
        let line = match *self.rows.get(row)? {
            Row::Line { file, hunk, line } => self.files[file].hunks()?.get(hunk)?.lines.get(line)?,
            Row::Split { file, hunk, left, right } => {
                let ix = if half == 0 { left? } else { right? };
                self.files[file].hunks()?.get(hunk)?.lines.get(ix)?
            }
            _ => return None,
        };
        Some(&line.text)
    }

    fn offset_at(&self, row: usize, half: u8, position: gpui::Point<Pixels>) -> usize {
        let layouts = self.layouts.borrow();
        match layouts.get(&(row, half)) {
            Some(layout) => match layout.index_for_position(position) {
                Ok(ix) | Err(ix) => ix,
            },
            None => 0,
        }
    }

    pub(super) fn select_start(&mut self, row: usize, half: u8, position: gpui::Point<Pixels>, extend: bool, cx: &mut Context<Self>) {
        let offset = self.offset_at(row, half, position);
        let point = CodePoint { row, half, offset };
        self.selection = Some(match self.selection {
            Some(sel) if extend && sel.anchor.half == half => CodeSelection { head: point, dragging: true, ..sel },
            _ => CodeSelection { anchor: point, head: point, dragging: true },
        });
        cx.notify();
    }

    pub(super) fn select_move(&mut self, row: usize, half: u8, position: gpui::Point<Pixels>, cx: &mut Context<Self>) {
        let Some(sel) = self.selection.filter(|s| s.dragging && s.anchor.half == half) else { return };
        let offset = self.offset_at(row, half, position);
        let head = CodePoint { row, half, offset };
        if head != sel.head {
            self.selection = Some(CodeSelection { head, ..sel });
            cx.notify();
        }
    }

    pub(super) fn select_end(&mut self, cx: &mut Context<Self>) {
        if let Some(sel) = self.selection.as_mut().filter(|s| s.dragging) {
            sel.dragging = false;
            if sel.anchor == sel.head {
                self.selection = None;
            }
            cx.notify();
        }
    }

    /// The selected code as text: one line per row, without gutters or markers (they are `select-none` there).
    pub fn selected_text(&self) -> Option<String> {
        let sel = self.selection?;
        let (lo, hi) = sel.ordered();
        let mut out: Vec<&str> = Vec::new();
        for row in lo.row..=hi.row {
            let Some(text) = self.cell_text(row, sel.anchor.half) else { continue };
            if let Some(range) = sel.range_in(row, sel.anchor.half, text.len()) {
                let range = floor_char(text, range.start)..floor_char(text, range.end);
                out.push(&text[range]);
            }
        }
        (!out.is_empty()).then(|| out.join("\n"))
    }

    /// Selects every line of one file (the tests' way of selecting without a pointer).
    pub fn select_rows(&mut self, from: usize, to: usize, cx: &mut Context<Self>) {
        let end = self.cell_text(to, 0).map(str::len).unwrap_or(0);
        self.selection = Some(CodeSelection {
            anchor: CodePoint { row: from, half: 0, offset: 0 },
            head: CodePoint { row: to, half: 0, offset: end },
            dragging: false,
        });
        cx.notify();
    }

    pub(super) fn copy(&mut self, cx: &mut Context<Self>) {
        if let Some(text) = self.selected_text() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    // --- decorations -------------------------------------------------------------------------------------------

    /// Changed-word ranges (UTF-16) per line of a hunk, paired as the split view pairs them.
    pub(super) fn words_for(&self, file: usize, hunk: usize) -> Option<Rc<HunkWords>> {
        if let Some(words) = self.words.borrow().get(&(file, hunk)) {
            return Some(words.clone());
        }
        let h = self.files.get(file)?.hunks()?.get(hunk)?;
        let mut out: Vec<Option<Vec<Utf16Range>>> = vec![None; h.lines.len()];
        let index = |target: &crate::logic::diff::DiffLine| h.lines.iter().position(|l| std::ptr::eq(l, target));
        for pair in split_rows(h) {
            let (Some(left), Some(right)) = (pair.left, pair.right) else { continue };
            if left.kind != LineKind::Remove || right.kind != LineKind::Add {
                continue;
            }
            let changes = word_changes(&left.text, &right.text);
            if let (Some(l), Some(r)) = (index(left), index(right)) {
                out[l] = Some(changes.old);
                out[r] = Some(changes.new);
            }
        }
        let out = Rc::new(out);
        self.words.borrow_mut().insert((file, hunk), out.clone());
        Some(out)
    }

    /// Syntax runs for a hunk line (see `highlight.rs`). A short hunk is parsed here, at once; a long one in the
    /// background, a chunk at a time, its rows plain until their chunk arrives.
    pub(super) fn runs_for(&self, file: usize, hunk: usize, line: usize) -> Option<Runs> {
        let mut stats = self.stats.get();
        stats.highlighted_lines += 1;
        self.stats.set(stats);
        let mut map = self.styles.borrow_mut();
        let entry = map.entry((file, hunk)).or_insert_with(|| {
            let state = self.files.get(file)?;
            let h = state.hunks()?.get(hunk)?;
            let syntax = syntax_for(&state.entry.path)?;
            if h.lines.len() <= SYNC_HIGHLIGHT_LINES {
                let mut highlighter = HunkHighlighter::new(syntax, h);
                Some((0..h.lines.len()).map(|ix| highlighter.runs(h, ix).cloned()).collect())
            } else {
                self.wanted.borrow_mut().push((file, hunk));
                Some(Vec::new())
            }
        });
        entry.as_ref()?.get(line).cloned().flatten()
    }

    /// Starts the background parses `runs_for` asked for.
    pub(super) fn spawn_highlights(&self, cx: &mut Context<Self>) {
        let wanted: Vec<(usize, usize)> = self.wanted.borrow_mut().drain(..).collect();
        for (file, hunk) in wanted {
            let Some(state) = self.files.get(file) else { continue };
            let (Some(h), Some(syntax)) = (state.hunks().and_then(|h| h.get(hunk)), syntax_for(&state.entry.path)) else { continue };
            let h = std::sync::Arc::new(h.clone());
            let epoch = self.epoch;
            cx.spawn(async move |this, cx| {
                let mut highlighter = Some(HunkHighlighter::new(syntax, &h));
                let mut next = 0;
                while next < h.lines.len() {
                    let end = (next + BACKGROUND_CHUNK).min(h.lines.len());
                    let (job_h, mut job) = (h.clone(), highlighter.take());
                    let (back, runs) = cx
                        .background_executor()
                        .spawn(async move {
                            let runs: Vec<Option<Runs>> = match job.as_mut() {
                                Some(hl) => (next..end).map(|ix| hl.runs(&job_h, ix).cloned()).collect(),
                                None => Vec::new(),
                            };
                            (job, runs)
                        })
                        .await;
                    highlighter = back;
                    next = end;
                    let kept = this
                        .update(cx, |view, cx| {
                            if view.epoch != epoch {
                                return false;
                            }
                            if let Some(Some(runs_so_far)) = view.styles.borrow_mut().get_mut(&(file, hunk)) {
                                runs_so_far.extend(runs);
                            }
                            cx.notify();
                            true
                        })
                        .unwrap_or(false);
                    if !kept {
                        break;
                    }
                }
            })
            .detach();
        }
    }
}

/// The largest char boundary at or before `ix`.
fn floor_char(text: &str, mut ix: usize) -> usize {
    ix = ix.min(text.len());
    while !text.is_char_boundary(ix) {
        ix -= 1;
    }
    ix
}

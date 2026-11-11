//! The transcript's half of find in chat (WP-28): the matches over every message, drawn or not, the active one, and
//! the highlights on the messages that are drawn.
//!
//! - A query scans each message's [`SearchText`], built from its source once and kept while the text is unchanged,
//!   so typing parses nothing ([`Transcript::set_find_query`]). Matches are ranges of each message's source, in
//!   document order; the first is active, as the desktop's search jumps to its first match.
//! - Highlights go on as each message is drawn ([`Transcript::sync_find`] in `row`): the source ranges become ranges
//!   of what its text view renders (`RenderedText::range_for_source`) and are set as range highlights, the active one
//!   darker. A message is set again only when the matches or its rendered text changed (its parse landed, a stream
//!   appended), so scrolling and the drag never repeat it.
//! - Stepping to a match scrolls its message into the list (`ListState::scroll_to`) when it is not on screen, then
//!   asks its text view to reveal the match's line once it is drawn (`TextViewState::reveal_range`, which scrolls the
//!   enclosing list).
//! - New text while the bar is open (a streamed answer, a new message) searches again and keeps the same match active
//!   (`FindBar.tsx` does it from a `MutationObserver`); a match that went away leaves the active index clamped.

use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui::{Context, Entity, Hsla, ListOffset, Rgba, SharedString, px};
use gpui_base::{RangeHighlight, RenderedText, TextViewState};

use super::{Item, Transcript};
use crate::theme::ActiveTheme;
use crate::ui::markdown::plain_text_source;
use crate::workspace::chat::find::{SearchText, clamp_match, find_label, step_match};

/// `::highlight(find-match)` is `orange` at 28%, `::highlight(find-active)` at 70% (`styles.css`).
const MATCH_ALPHA: f32 = 0.28;
const ACTIVE_ALPHA: f32 = 0.70;
/// Texts up to this long are compared by content when the search index checks they are unchanged.
const SHORT: usize = 64;

/// One match: a range of message `item`'s source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub item: usize,
    pub source: Range<usize>,
}

/// The open find bar's state in the transcript.
#[derive(Default)]
pub struct FindState {
    pub query: String,
    needle: String,
    pub hits: Vec<Hit>,
    pub active: usize,
    /// Bumped whenever the highlights to show change (new matches, another active one).
    generation: u64,
    /// The active match still has to be scrolled to once its message is drawn.
    reveal: bool,
    /// What each message's text view was last given: its rendered text then, the generation, and whether it holds
    /// a highlight.
    applied: HashMap<usize, (RenderedText, u64, bool)>,
    /// How long the last search took and over how many messages, for the measurements.
    pub last_search: Duration,
}

impl FindState {
    /// The matches in message `ix`, with their place in the whole list.
    fn hits_in(&self, ix: usize) -> impl Iterator<Item = (usize, &Hit)> {
        let from = self.hits.partition_point(|hit| hit.item < ix);
        let to = self.hits.partition_point(|hit| hit.item <= ix);
        (from..to).map(move |n| (n, &self.hits[n]))
    }
}

/// Each message's search text, keyed by its index, with the text it was built from. A message's text is replaced,
/// never edited in place, so the same shared string means the same text (a short one is stored inline, so it is
/// compared by content).
#[derive(Default)]
pub struct SearchIndex {
    texts: HashMap<usize, (SharedString, Rc<SearchText>)>,
    /// How many messages have been read into search text (each one a parse), for the measurements.
    pub built: usize,
}

impl SearchIndex {
    pub fn clear(&mut self) {
        self.texts.clear();
    }
}

impl Transcript {
    /// The open find's state, if the bar is open.
    pub fn find_state(&self) -> Option<&FindState> {
        self.find.as_ref()
    }

    /// `(active, total)` while a query is typed.
    pub fn find_status(&self) -> Option<(usize, usize)> {
        self.find.as_ref().filter(|find| !find.query.is_empty()).map(|find| (find.active, find.hits.len()))
    }

    /// What the bar's count says: "3 of 12", "No results", or nothing.
    pub fn find_label(&self) -> String {
        self.find.as_ref().map(|find| find_label(&find.query, find.active, find.hits.len())).unwrap_or_default()
    }

    /// The messages whose text views hold find highlights now, in order.
    pub fn find_highlighted(&self) -> Vec<usize> {
        let Some(find) = &self.find else { return Vec::new() };
        let mut items: Vec<usize> = find.applied.iter().filter(|(_, (_, _, lit))| *lit).map(|(ix, _)| *ix).collect();
        items.sort_unstable();
        items
    }

    /// How many messages were read into search text since the transcript was created.
    pub fn search_texts_built(&self) -> usize {
        self.search_index.built
    }

    /// The query changed: search every message again and make the first match active, scrolled into view.
    pub fn set_find_query(&mut self, query: &str, cx: &mut Context<Self>) {
        let mut find = self.find.take().unwrap_or_default();
        find.query = query.to_string();
        find.needle = query.to_lowercase();
        let started = Instant::now();
        find.hits = self.search(&find.needle);
        find.last_search = started.elapsed();
        find.active = 0;
        find.generation += 1;
        find.reveal = !find.hits.is_empty();
        self.find = Some(find);
        self.scroll_to_active();
        cx.notify();
    }

    /// ⌘G, Enter, the arrows: the next (`1`) or previous (`-1`) match, wrapping, scrolled into view.
    pub fn step_find(&mut self, direction: isize, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut().filter(|find| !find.hits.is_empty()) else { return };
        find.active = step_match(find.active, find.hits.len(), direction);
        find.generation += 1;
        find.reveal = true;
        self.scroll_to_active();
        cx.notify();
    }

    /// The bar closed: every highlight goes.
    pub fn close_find(&mut self, cx: &mut Context<Self>) {
        let Some(find) = self.find.take() else { return };
        for ix in find.applied.keys() {
            if let Some(views) = self.views.get(ix) {
                views.main.update(cx, |state, cx| state.clear_range_highlights(cx));
            }
        }
        cx.notify();
    }

    /// The messages changed under an open bar (a stream, a new message): search again, keeping the active match
    /// where it was, without scrolling.
    pub(super) fn refresh_find(&mut self) {
        let Some(mut find) = self.find.take() else { return };
        if !find.query.is_empty() {
            let previous = find.hits.get(find.active).cloned();
            let hits = self.search(&find.needle);
            if hits != find.hits {
                let kept = previous.and_then(|previous| hits.iter().position(|hit| *hit == previous));
                find.active = kept.unwrap_or_else(|| clamp_match(find.active, hits.len()));
                find.hits = hits;
                find.generation += 1;
            }
        }
        self.find = Some(find);
    }

    /// Every match of `needle` (lowercased), in document order.
    fn search(&mut self, needle: &str) -> Vec<Hit> {
        let mut hits = Vec::new();
        if needle.is_empty() {
            return hits;
        }
        let mut ranges = Vec::new();
        for ix in 0..self.items.len() {
            let Some(text) = self.search_text(ix) else { continue };
            ranges.clear();
            text.find(needle, &mut ranges);
            hits.extend(ranges.drain(..).map(|source| Hit { item: ix, source }));
        }
        hits
    }

    /// Message `ix`'s search text, read from its source the first time and whenever its text changes.
    fn search_text(&mut self, ix: usize) -> Option<Rc<SearchText>> {
        let text = match self.items.get(ix)? {
            Item::User(text) => text.clone(),
            // A streamed answer's text is what has been shown so far (`flush_stream` updates it per batch).
            Item::Prose(prose) => prose.text.clone(),
            _ => return None,
        };
        if let Some((was, built)) = self.search_index.texts.get(&ix)
            && was.len() == text.len()
            && (was.as_ptr() == text.as_ptr() || (text.len() <= SHORT && *was == text))
        {
            return Some(built.clone());
        }
        let source = match &self.items[ix] {
            Item::User(typed) => plain_text_source(typed),
            _ => text.to_string(),
        };
        let built = Rc::new(SearchText::new(&source));
        self.search_index.built += 1;
        self.search_index.texts.insert(ix, (text, built.clone()));
        Some(built)
    }

    /// Brings the active match's message into the list when it is not fully on screen; its line is revealed once it
    /// is drawn (`sync_find`).
    fn scroll_to_active(&mut self) {
        let Some(item) = self.find.as_ref().and_then(|find| find.hits.get(find.active)).map(|hit| hit.item) else { return };
        let viewport = self.list.viewport_bounds();
        let on_screen = self
            .list
            .bounds_for_item(item)
            .is_some_and(|bounds| bounds.top() >= viewport.top() && bounds.bottom() <= viewport.bottom() && viewport.size.height > px(0.0));
        if !on_screen {
            self.list.scroll_to(ListOffset { item_ix: item, offset_in_item: px(0.0) });
        }
    }

    /// Puts the matches of message `ix` on its text view, as it is drawn, when they or its text changed since.
    pub(super) fn sync_find(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(views) = self.views.get(&ix) else { return };
        let main = views.main.clone();
        let Some(find) = self.find.as_mut() else { return };
        let rendered = main.read(cx).rendered_text();
        if find.applied.get(&ix).is_some_and(|(text, generation, _)| *text == rendered && *generation == find.generation) {
            return;
        }
        let orange = cx.theme().orange;
        let (matched, active) = (tint(orange, MATCH_ALPHA), tint(orange, ACTIVE_ALPHA));
        let mut highlights = Vec::new();
        let mut reveal = None;
        let source_len = rendered.source().len();
        for (n, hit) in find.hits_in(ix) {
            // A streamed answer's view holds its finished blocks only: a match past them waits for the next batch.
            if hit.source.end > source_len {
                continue;
            }
            let Some(range) = rendered.range_for_source(hit.source.clone()) else { continue };
            if n == find.active && find.reveal {
                reveal = Some(range.clone());
            }
            highlights.push(RangeHighlight::new(range, if n == find.active { active } else { matched }));
        }
        let had = find.applied.contains_key(&ix);
        if highlights.is_empty() && !had && reveal.is_none() {
            return;
        }
        find.applied.insert(ix, (rendered, find.generation, !highlights.is_empty()));
        if reveal.is_some() {
            find.reveal = false;
        }
        apply(&main, highlights, reveal, cx);
    }
}

fn apply(main: &Entity<TextViewState>, highlights: Vec<RangeHighlight>, reveal: Option<Range<usize>>, cx: &mut Context<Transcript>) {
    main.update(cx, |state, cx| {
        if highlights.is_empty() {
            state.clear_range_highlights(cx);
        } else {
            // Ranges come from this parse's own text, so they are valid; a rejected set leaves the old one.
            state.set_range_highlights(highlights, cx).ok();
        }
        if let Some(range) = reveal {
            state.reveal_range(range, cx).ok();
        }
    });
}

fn tint(color: Rgba, alpha: f32) -> Hsla {
    Rgba { a: alpha, ..color }.into()
}

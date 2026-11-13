//! Find in chat (WP-28): what a search runs over, how it matches and counts. A port of `lib/find-in-chat.ts` and of
//! the DOM walk in `FindBar.tsx`, over the Markdown source instead of the DOM.
//!
//! The desktop walks the text nodes under the Chat column, joins the ones inside one block (the nearest ancestor
//! that is not inline, so "a **bold** word" reads as one string) and searches each block, case-insensitively and
//! without overlaps. Here a message's [`SearchText`] is built once from its source (one Markdown parse, the same
//! pass `ui::selection::plain` makes), keeping the source bytes each piece of text came from. A query then scans the
//! lowercased blocks only: typing never parses a message again. A hit is a range of the message's source, which the
//! transcript turns into the range its text view draws (`RenderedText::range_for_source`) when the message is drawn.
//!
//! What counts as searchable: the text of user messages and assistant answers, drawn or not (the desktop loads every
//! message while the bar is open). Tool rows, approvals and cards are not searched (the desktop searches the visible
//! text of unfolded rows too); see README.md "Find in chat".

use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// `matchOffsets`: the start of every case-insensitive, non-overlapping occurrence of `query` in `text`, in bytes.
/// None when lowercasing changes the text's length (offsets would no longer line up with it), as the desktop does.
pub fn match_offsets(text: &str, query: &str) -> Vec<usize> {
    if query.is_empty() {
        return Vec::new();
    }
    let haystack = text.to_lowercase();
    if haystack.len() != text.len() {
        return Vec::new();
    }
    haystack.match_indices(&query.to_lowercase()).map(|(at, _)| at).collect()
}

/// `stepMatch`: the next (`direction` 1) or previous (-1) match, wrapping at both ends.
pub fn step_match(current: usize, total: usize, direction: isize) -> usize {
    if total == 0 {
        return 0;
    }
    (current as isize + direction).rem_euclid(total as isize) as usize
}

/// `clampMatch`: the active match kept in range after the matches changed under it.
pub fn clamp_match(current: usize, total: usize) -> usize {
    if total == 0 { 0 } else { current.min(total - 1) }
}

/// `findLabel`: "3 of 12", "No results", or nothing without a query.
pub fn find_label(query: &str, current: usize, total: usize) -> String {
    if query.is_empty() {
        String::new()
    } else if total == 0 {
        "No results".to_string()
    } else {
        format!("{} of {}", current + 1, total)
    }
}

/// A piece of a block's text and the source bytes it came from. `exact` when the text is those bytes as written
/// (each byte maps to itself); otherwise (an escape, an entity, a line break) the whole piece maps to all of them.
#[derive(Clone, Debug)]
struct Piece {
    at: usize,
    len: usize,
    source: Range<usize>,
    exact: bool,
}

/// One block's text, lowercased for matching, with its pieces in order.
#[derive(Clone, Debug, Default)]
struct Block {
    lower: String,
    /// False when lowercasing changed the length: the block cannot match (`matchOffsets`).
    aligned: bool,
    pieces: Vec<Piece>,
}

impl Block {
    /// The source bytes the block text `range` came from.
    fn source_range(&self, range: Range<usize>) -> Range<usize> {
        let piece_at = |offset: usize| {
            let ix = self.pieces.partition_point(|piece| piece.at + piece.len <= offset);
            &self.pieces[ix.min(self.pieces.len() - 1)]
        };
        let first = piece_at(range.start);
        let last = piece_at(range.end.saturating_sub(1).max(range.start));
        let start = if first.exact { first.source.start + (range.start - first.at) } else { first.source.start };
        let end = if last.exact { last.source.start + (range.end - last.at).min(last.len) } else { last.source.end };
        start..end.max(start)
    }
}

/// A message's searchable text: its blocks as the desktop's walk groups them, built once from the source.
#[derive(Clone, Debug, Default)]
pub struct SearchText {
    blocks: Vec<Block>,
}

impl SearchText {
    /// Reads `source` (an answer's Markdown, or a user message as `plain_text_source` escapes it) into blocks.
    pub fn new(source: &str) -> Self {
        let mut builder = Builder { source, blocks: Vec::new(), text: String::new(), pieces: Vec::new() };
        let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
        for (event, at) in Parser::new_ext(source, options).into_offset_iter() {
            builder.event(event, at);
        }
        builder.flush();
        Self { blocks: builder.blocks }
    }

    /// The text of each block, for tests.
    pub fn blocks(&self) -> Vec<String> {
        self.blocks.iter().map(|block| block.lower.clone()).collect()
    }

    /// Appends the source range of every match of `needle` (already lowercased, not empty) to `out`, in order.
    pub fn find(&self, needle: &str, out: &mut Vec<Range<usize>>) {
        if needle.is_empty() {
            return;
        }
        for block in &self.blocks {
            if !block.aligned || block.lower.len() < needle.len() {
                continue;
            }
            for (at, found) in block.lower.match_indices(needle) {
                out.push(block.source_range(at..at + found.len()));
            }
        }
    }

    /// How many bytes of text the blocks hold (for the measurements).
    pub fn len(&self) -> usize {
        self.blocks.iter().map(|block| block.lower.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

struct Builder<'a> {
    source: &'a str,
    blocks: Vec<Block>,
    text: String,
    pieces: Vec<Piece>,
}

impl Builder<'_> {
    fn push(&mut self, text: &str, at: Range<usize>) {
        if text.is_empty() {
            return;
        }
        let written = self.source.get(at.clone()).unwrap_or_default();
        // Inline code's text sits inside its backticks; an image's alt inside its brackets.
        let (source, exact) = match written.find(text) {
            Some(offset) => (at.start + offset..at.start + offset + text.len(), true),
            None => (at, false),
        };
        self.pieces.push(Piece { at: self.text.len(), len: text.len(), source, exact });
        self.text.push_str(text);
    }

    /// A block boundary: the text so far is one block.
    fn flush(&mut self) {
        if self.text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.text);
        let lower = text.to_lowercase();
        let aligned = lower.len() == text.len();
        self.blocks.push(Block { lower, aligned, pieces: std::mem::take(&mut self.pieces) });
    }

    fn event(&mut self, event: Event<'_>, at: Range<usize>) {
        match event {
            Event::Start(tag) if is_block(&tag) => self.flush(),
            Event::End(tag) if ends_block(&tag) => self.flush(),
            Event::Text(text) | Event::Code(text) | Event::InlineHtml(text) | Event::InlineMath(text) | Event::DisplayMath(text) => {
                self.push(&text, at)
            }
            // Raw HTML shows as text (react-markdown's default), a block of its own.
            Event::Html(text) => self.push(&text, at),
            Event::SoftBreak | Event::HardBreak => self.push("\n", at),
            Event::FootnoteReference(label) => self.push(&label, at),
            Event::Rule => self.flush(),
            _ => {}
        }
    }
}

fn is_block(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::Paragraph
            | Tag::Heading { .. }
            | Tag::BlockQuote(_)
            | Tag::CodeBlock(_)
            | Tag::HtmlBlock
            | Tag::List(_)
            | Tag::Item
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell
            | Tag::FootnoteDefinition(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition
    )
}

fn ends_block(tag: &TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
            | TagEnd::FootnoteDefinition
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition
    )
}

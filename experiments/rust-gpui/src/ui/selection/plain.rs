//! A Markdown message as the desktop copies it: the `text/plain` Chromium writes for a DOM selection over the
//! message as `Markdown.tsx` renders it, computed from the source and a byte range of it.
//!
//! Chromium's `TextIterator` (what `Editor::SelectedTextForClipboard` runs) emits text nodes as laid out, a newline
//! before and after every block, and a second one after a `<p>` (`ShouldEmitExtraNewlineForNode`; headings get it
//! only when their bottom margin is at least half their font size, and `.markdown` gives them 0.4em). Newlines
//! between blocks collapse into the largest one asked for, and none are written before the first text or after the
//! last. So, for the desktop's DOM:
//!
//! | Source | Copied |
//! | --- | --- |
//! | Paragraph | its text, then a blank line before what follows |
//! | Heading, list item, quote, rule | its text on its own line |
//! | Raw HTML | its source as text in flow, a block on its own line |
//! | List markers (`li::marker`), task checkboxes | nothing |
//! | Table | cells joined by a tab, a row per line |
//! | Code block (`CodeBlock.tsx`) | the header's language (`fence.toLowerCase() \|\| "text"`) on a line when the selection starts before the block, then the code as written, without its final newline |
//! | `markdown` fence | the nested message, serialised the same way |
//! | `mermaid` fence | its source (the desktop draws a diagram; the port shows the source) |
//! | Inline code, file chips, links | their text |
//! | Image | its alt text, else its address, else `image` (the desktop shows replies' images as links) |
//! | Soft line break, runs of spaces | one space (`white-space: normal`); a hard break is a newline |
//!
//! [`Flavor::PreWrap`] is a user message: typed text in a `whitespace-pre-wrap` bubble, so spaces and newlines stay.
//!
//! Known differences, all small: Chromium leaves `user-select: none` content out, and a file chip is a `<button>`,
//! so Electron copies a selection without a chip's text where this keeps it (the port's brief asks for chip tokens);
//! a selection that ends in collapsed whitespace keeps one space here.

use std::borrow::Cow;
use std::ops::Range;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use crate::ui::markdown::fences::FenceKind;

/// How a message's text is laid out in the desktop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    /// An answer rendered from Markdown (`white-space: normal`).
    Markdown,
    /// A user message: its source escapes the typed text (`ui::markdown::plain_text_source`), and the bubble keeps
    /// spaces and line breaks (`whitespace-pre-wrap`).
    PreWrap,
}

/// The copied text of one message, and how many newlines its last block asks for before whatever follows it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plain {
    pub text: String,
    pub trailing_breaks: u8,
}

impl Plain {
    /// Text that ends with an ordinary block (one newline before the next message).
    pub fn block(text: impl Into<String>) -> Self {
        Self { text: text.into(), trailing_breaks: 1 }
    }
}

/// Joins messages as Chromium joins the blocks that hold them: the newlines the earlier one's last block asks for,
/// at least one. Empty parts take no room.
pub fn join(parts: impl IntoIterator<Item = Plain>) -> String {
    let mut out = String::new();
    let mut breaks = 0;
    for part in parts {
        if part.text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.extend(std::iter::repeat_n('\n', usize::from(breaks.max(1))));
        }
        out.push_str(&part.text);
        breaks = part.trailing_breaks;
    }
    out
}

/// The text a selection over the bytes `range` of the Markdown `source` copies. `0..source.len()` is the whole
/// message.
pub fn plain_text(source: &str, range: Range<usize>, flavor: Flavor) -> Plain {
    let range = range.start.min(source.len())..range.end.min(source.len());
    if range.is_empty() {
        return Plain::default();
    }
    let mut serializer = Serializer::new(source, range, flavor);
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (event, at) in Parser::new_ext(source, options).into_offset_iter() {
        serializer.event(event, at);
    }
    Plain { text: serializer.out.text, trailing_breaks: serializer.out.pending }
}

/// The text written so far, the newlines owed before the next text, and whether the last character written is a
/// collapsible space (dropped at a line's end, as layout drops it).
#[derive(Default)]
struct Out {
    text: String,
    pending: u8,
    soft_space: bool,
}

impl Out {
    /// The next text starts at least `count` newlines further, if any text came before.
    fn require(&mut self, count: u8) {
        if self.text.is_empty() {
            return;
        }
        if self.soft_space && self.text.ends_with(' ') {
            self.text.pop();
        }
        self.soft_space = false;
        self.pending = self.pending.max(count);
    }

    fn flush_breaks(&mut self) {
        if self.pending > 0 {
            self.text.extend(std::iter::repeat_n('\n', usize::from(self.pending)));
            self.pending = 0;
        }
    }

    /// Text that keeps its whitespace (code, a pre-wrap bubble, a tab between cells).
    fn verbatim(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.flush_breaks();
        self.text.push_str(text);
        self.soft_space = false;
    }

    /// Text in normal flow: each run of whitespace is one space, none at the start of a line.
    fn flow(&mut self, text: &str) {
        let mut collapsed = String::with_capacity(text.len());
        let mut in_space = false;
        for c in text.chars() {
            if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}') {
                in_space = true;
            } else {
                if in_space {
                    collapsed.push(' ');
                }
                in_space = false;
                collapsed.push(c);
            }
        }
        if in_space {
            collapsed.push(' ');
        }
        let at_line_start = self.text.is_empty() || self.pending > 0 || self.text.ends_with(['\n', ' ', '\t']);
        let collapsed = if at_line_start { collapsed.trim_start_matches(' ') } else { collapsed.as_str() };
        if collapsed.is_empty() {
            return;
        }
        self.flush_breaks();
        self.text.push_str(collapsed);
        self.soft_space = collapsed.ends_with(' ');
    }
}

/// A fenced or indented block being read: its text inside the selection, collected until it ends.
struct Code {
    kind: FenceKind,
    text: String,
    /// The selection reaches the block's last byte, so its final newline is the one the desktop strips.
    to_end: bool,
}

struct Serializer<'a> {
    source: &'a str,
    range: Range<usize>,
    flavor: Flavor,
    out: Out,
    code: Option<Code>,
    /// The alt text of an image being read, and its address.
    image: Option<(String, String)>,
    /// Cells seen in the current table row.
    cell: usize,
}

impl<'a> Serializer<'a> {
    fn new(source: &'a str, range: Range<usize>, flavor: Flavor) -> Self {
        Self { source, range, flavor, out: Out::default(), code: None, image: None, cell: 0 }
    }

    fn touches(&self, at: &Range<usize>) -> bool {
        at.start < self.range.end && at.end > self.range.start
    }

    /// The part of `text` (the event covering the source bytes `at`) inside the selection. Text that differs from
    /// its source (an escape, an entity) is taken whole when the selection touches it.
    fn clip<'t>(&self, text: &'t str, at: &Range<usize>) -> Option<Cow<'t, str>> {
        if !self.touches(at) {
            return None;
        }
        if at.start >= self.range.start && at.end <= self.range.end {
            return Some(Cow::Borrowed(text));
        }
        if self.source.get(at.clone()) == Some(text) {
            let from = self.range.start.max(at.start) - at.start;
            let to = self.range.end.min(at.end) - at.start;
            return Some(Cow::Borrowed(text.get(from..to).unwrap_or(text)));
        }
        Some(Cow::Borrowed(text))
    }

    fn require(&mut self, at: &Range<usize>, count: u8) {
        if self.touches(at) {
            self.out.require(count);
        }
    }

    fn text(&mut self, text: &str) {
        match self.flavor {
            Flavor::Markdown => self.out.flow(text),
            Flavor::PreWrap => self.out.verbatim(text),
        }
    }

    fn event(&mut self, event: Event<'_>, at: Range<usize>) {
        match event {
            Event::Start(tag) => self.start(tag, at),
            Event::End(tag) => self.end(tag, at),
            Event::Text(text) => {
                let Some(part) = self.clip(&text, &at) else { return };
                let part = part.into_owned();
                if let Some(code) = &mut self.code {
                    code.text.push_str(&part);
                    code.to_end = at.end <= self.range.end;
                } else if let Some((alt, _)) = &mut self.image {
                    alt.push_str(&part);
                } else {
                    self.text(&part);
                }
            }
            Event::Code(text) | Event::InlineHtml(text) | Event::InlineMath(text) | Event::DisplayMath(text) => {
                if let Some(part) = self.clip(&text, &at) {
                    let part = part.into_owned();
                    self.text(&part);
                }
            }
            // Raw HTML shows as text in the message's flow (react-markdown's default).
            Event::Html(text) => {
                if let Some(part) = self.clip(&text, &at) {
                    let part = part.into_owned();
                    self.text(&part);
                }
            }
            Event::SoftBreak if self.touches(&at) => match self.flavor {
                Flavor::Markdown => self.out.flow(" "),
                Flavor::PreWrap => self.out.verbatim("\n"),
            },
            Event::HardBreak if self.touches(&at) => self.out.verbatim("\n"),
            Event::Rule => self.require(&at, 1),
            Event::FootnoteReference(label) if self.touches(&at) => self.text(&label),
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>, at: Range<usize>) {
        match tag {
            Tag::CodeBlock(kind) => {
                self.require(&at, 1);
                let info = match &kind {
                    CodeBlockKind::Fenced(info) => Some(info.as_ref()),
                    CodeBlockKind::Indented => None,
                };
                let fence = FenceKind::of(info.filter(|info| !info.trim().is_empty()));
                // The header (`CodeBlock.tsx`) is above the code: copied when the selection starts before the block.
                if fence == FenceKind::Code && self.range.start <= at.start && self.touches(&at) {
                    let label = info.and_then(|info| info.split_whitespace().next()).map(str::to_lowercase);
                    self.out.verbatim(label.as_deref().filter(|label| !label.is_empty()).unwrap_or("text"));
                    self.out.require(1);
                }
                self.code = Some(Code { kind: fence, text: String::new(), to_end: false });
            }
            Tag::Image { dest_url, .. } => self.image = Some((String::new(), dest_url.to_string())),
            Tag::TableRow | Tag::TableHead => {
                self.require(&at, 1);
                self.cell = 0;
            }
            Tag::TableCell => {
                if self.cell > 0 && self.touches(&at) && !self.out.text.is_empty() {
                    self.out.verbatim("\t");
                }
                self.cell += 1;
            }
            Tag::Paragraph
            | Tag::Heading { .. }
            | Tag::BlockQuote(_)
            | Tag::List(_)
            | Tag::Item
            | Tag::Table(_)
            | Tag::HtmlBlock
            | Tag::FootnoteDefinition(_)
            | Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition => self.require(&at, 1),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd, at: Range<usize>) {
        match tag {
            // `<p>` is the one block Chromium follows with a blank line.
            TagEnd::Paragraph => self.require(&at, 2),
            TagEnd::CodeBlock => {
                let Some(code) = self.code.take() else { return };
                let mut text = code.text;
                if code.to_end && text.ends_with('\n') {
                    text.pop();
                }
                match code.kind {
                    FenceKind::Markdown => {
                        let nested = plain_text(&text, 0..text.len(), Flavor::Markdown);
                        self.out.verbatim(&nested.text);
                    }
                    FenceKind::Mermaid | FenceKind::GenerativeUi | FenceKind::Code => self.out.verbatim(&text),
                }
                self.require(&at, 1);
            }
            TagEnd::Image => {
                let Some((alt, url)) = self.image.take() else { return };
                if self.touches(&at) {
                    let shown = if !alt.is_empty() {
                        alt
                    } else if !url.is_empty() {
                        url
                    } else {
                        "image".to_string()
                    };
                    self.text(&shown);
                }
            }
            TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::HtmlBlock
            | TagEnd::FootnoteDefinition
            | TagEnd::DefinitionList
            | TagEnd::DefinitionListTitle
            | TagEnd::DefinitionListDefinition => self.require(&at, 1),
            _ => {}
        }
    }
}

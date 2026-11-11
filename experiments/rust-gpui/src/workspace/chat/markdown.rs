//! Assistant prose: markdown parsed once into blocks, then drawn with GPUI elements.
//!
//! `parse` turns CommonMark (pulldown-cmark events) into a small block tree: paragraphs, headings,
//! lists, fenced code, quotes and rules. Inline styles (bold, italic, inline code, links) become
//! contiguous spans over one string per paragraph, which `render` maps to GPUI `TextRun`s so a
//! paragraph is a single wrapped text element.
//!
//! What GPUI 0.2.2 cannot do here, and how it shows:
//! - A `TextRun` has a font, colours and decorations but no size, padding or radius. Inline code is
//!   the mono font with a `field` background drawn edge to edge behind the glyphs: no 4px radius,
//!   no side padding, and the same size as the prose around it.
//! - Static text is not selectable. `StyledText` exposes its layout (index for a point and back),
//!   so selection is buildable, but nothing ships it.

use std::ops::Range;

use gpui::{
    App, ElementId, FontStyle, FontWeight, InteractiveText, IntoElement, SharedString, StyledText, TextRun, Window, div, font, prelude::*,
    px,
};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use crate::theme::{RADIUS_CONTROL, Theme};

/// The monospace family. `ui-monospace` (SF Mono) is not reachable by a family name on macOS:
/// `NSFontManager` lists only Andale Mono, Menlo and PT Mono, so the spike uses Menlo.
pub const MONO: &str = "Menlo";
/// GPUI's name for the platform UI font (SF Pro on macOS).
pub const SANS: &str = ".SystemUIFont";

/// Chat text: 14px at line height 1.6 (DESIGN.md, `--chat-size`).
pub const PROSE_SIZE: f32 = 14.0;
pub const PROSE_LINE_HEIGHT: f32 = PROSE_SIZE * 1.6;
const CODE_SIZE: f32 = 12.0;
const CODE_LINE_HEIGHT: f32 = 18.0;
const BLOCK_GAP: f32 = 12.0;
const LIST_GAP: f32 = 4.0;
const LIST_MARKER_WIDTH: f32 = 20.0;

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Paragraph(Inline),
    Heading {
        level: u8,
        inline: Inline,
    },
    /// `start` is `Some(n)` for a numbered list starting at n.
    List {
        start: Option<u64>,
        items: Vec<Vec<Block>>,
    },
    Code {
        lang: Option<SharedString>,
        text: SharedString,
    },
    Quote(Vec<Block>),
    Rule,
}

/// One paragraph's text and its styled spans. Spans are contiguous and cover the whole text.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inline {
    pub text: SharedString,
    pub spans: Vec<Span>,
    pub links: Vec<SharedString>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub style: SpanStyle,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpanStyle {
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    /// Index into `Inline::links`.
    pub link: Option<usize>,
}

/// Parses markdown into blocks. Cheap enough to run once per message when it arrives.
pub fn parse(source: &str) -> Vec<Block> {
    let mut builder = Builder::default();
    for event in Parser::new_ext(source, Options::ENABLE_STRIKETHROUGH) {
        builder.event(event);
    }
    builder.finish()
}

enum Frame {
    Blocks(Vec<Block>),
    List { start: Option<u64>, items: Vec<Vec<Block>> },
}

#[derive(Default)]
struct InlineBuilder {
    text: String,
    spans: Vec<Span>,
    links: Vec<SharedString>,
}

impl InlineBuilder {
    fn push(&mut self, text: &str, style: SpanStyle) {
        if text.is_empty() {
            return;
        }
        let start = self.text.len();
        self.text.push_str(text);
        let end = self.text.len();
        match self.spans.last_mut() {
            Some(last) if last.style == style && last.range.end == start => last.range.end = end,
            _ => self.spans.push(Span { range: start..end, style }),
        }
    }

    fn build(self) -> Inline {
        Inline { text: self.text.into(), spans: self.spans, links: self.links }
    }
}

#[derive(Default)]
struct Builder {
    frames: Vec<Frame>,
    inline: Option<InlineBuilder>,
    heading: Option<u8>,
    code: Option<(Option<SharedString>, String)>,
    bold: usize,
    italic: usize,
    links: Vec<usize>,
}

impl Builder {
    /// The innermost block container. pulldown-cmark always wraps list content in items, so the
    /// top frame is a list only for malformed input; that content then gets a container of its own.
    fn blocks(&mut self) -> &mut Vec<Block> {
        if !matches!(self.frames.last(), Some(Frame::Blocks(_))) {
            self.frames.push(Frame::Blocks(Vec::new()));
        }
        match self.frames.last_mut() {
            Some(Frame::Blocks(blocks)) => blocks,
            _ => unreachable!("a block frame is on top"),
        }
    }

    fn inline(&mut self) -> &mut InlineBuilder {
        // Tight list items carry their text without a Paragraph event: open an implicit one.
        self.inline.get_or_insert_with(InlineBuilder::default)
    }

    fn style(&self) -> SpanStyle {
        SpanStyle { bold: self.bold > 0, italic: self.italic > 0, code: false, link: self.links.last().copied() }
    }

    fn flush(&mut self) {
        let Some(inline) = self.inline.take() else { return };
        let level = self.heading.take();
        if inline.text.trim().is_empty() {
            return;
        }
        let inline = inline.build();
        let block = match level {
            Some(level) => Block::Heading { level, inline },
            None => Block::Paragraph(inline),
        };
        self.blocks().push(block);
    }

    fn event(&mut self, event: Event<'_>) {
        if let Some((_, code)) = self.code.as_mut() {
            match event {
                Event::Text(text) => code.push_str(&text),
                Event::End(TagEnd::CodeBlock) => {
                    let (lang, mut text) = self.code.take().expect("inside a code block");
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    self.blocks().push(Block::Code { lang, text: text.into() });
                }
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => {
                let style = self.style();
                self.inline().push(&text, style);
            }
            Event::Code(text) => {
                let style = SpanStyle { code: true, ..self.style() };
                self.inline().push(&text, style);
            }
            Event::SoftBreak => {
                let style = self.style();
                self.inline().push(" ", style);
            }
            Event::HardBreak => {
                let style = self.style();
                self.inline().push("\n", style);
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let style = self.style();
                self.inline().push(&html, style);
            }
            Event::Rule => {
                self.flush();
                self.blocks().push(Block::Rule);
            }
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                self.flush();
                self.inline = Some(InlineBuilder::default());
            }
            Tag::Heading { level, .. } => {
                self.flush();
                self.heading = Some(level as u8);
                self.inline = Some(InlineBuilder::default());
            }
            Tag::List(start) => {
                self.flush();
                self.frames.push(Frame::List { start, items: Vec::new() });
            }
            Tag::Item | Tag::BlockQuote(_) => {
                self.flush();
                self.frames.push(Frame::Blocks(Vec::new()));
            }
            Tag::CodeBlock(kind) => {
                self.flush();
                let lang = match kind {
                    CodeBlockKind::Fenced(lang) if !lang.is_empty() => Some(SharedString::from(lang.to_string())),
                    _ => None,
                };
                self.code = Some((lang, String::new()));
            }
            Tag::Strong => self.bold += 1,
            Tag::Emphasis => self.italic += 1,
            Tag::Link { dest_url, .. } => {
                let inline = self.inline();
                inline.links.push(dest_url.to_string().into());
                let ix = inline.links.len() - 1;
                self.links.push(ix);
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) => self.flush(),
            TagEnd::Item => {
                self.flush();
                let item = match self.frames.pop() {
                    Some(Frame::Blocks(blocks)) => blocks,
                    other => {
                        self.frames.extend(other);
                        return;
                    }
                };
                if let Some(Frame::List { items, .. }) = self.frames.last_mut() {
                    items.push(item);
                }
            }
            TagEnd::List(_) => {
                self.flush();
                if let Some(Frame::List { start, items }) = self.frames.pop() {
                    self.blocks().push(Block::List { start, items });
                }
            }
            TagEnd::BlockQuote(_) => {
                self.flush();
                if let Some(Frame::Blocks(blocks)) = self.frames.pop() {
                    self.blocks().push(Block::Quote(blocks));
                }
            }
            TagEnd::Strong => self.bold = self.bold.saturating_sub(1),
            TagEnd::Emphasis => self.italic = self.italic.saturating_sub(1),
            TagEnd::Link => {
                self.links.pop();
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Vec<Block> {
        self.flush();
        // Fold any unclosed frames (malformed input) back into the root.
        while self.frames.len() > 1 {
            match self.frames.pop() {
                Some(Frame::Blocks(blocks)) => self.blocks().extend(blocks),
                Some(Frame::List { start, items }) => self.blocks().push(Block::List { start, items }),
                None => {}
            }
        }
        match self.frames.pop() {
            Some(Frame::Blocks(blocks)) => blocks,
            _ => Vec::new(),
        }
    }
}

/// Draws parsed blocks in the 14/1.6 prose style. `id` keeps link hit-testing stable per item.
pub fn render(blocks: &[Block], id: usize, theme: &Theme) -> impl IntoElement + use<> {
    let mut counter = 0;
    div()
        .flex()
        .flex_col()
        .gap(px(BLOCK_GAP))
        .w_full()
        .min_w_0()
        .text_size(px(PROSE_SIZE))
        .line_height(px(PROSE_LINE_HEIGHT))
        .text_color(theme.ink)
        .children(blocks.iter().map(|block| render_block(block, id, &mut counter, theme)))
}

fn render_block(block: &Block, id: usize, counter: &mut usize, theme: &Theme) -> gpui::AnyElement {
    match block {
        Block::Paragraph(inline) => paragraph(inline, id, counter, theme, FontWeight::NORMAL).into_any_element(),
        Block::Heading { level, inline } => {
            let size = if *level <= 2 { 16.0 } else { PROSE_SIZE };
            div().text_size(px(size)).child(paragraph(inline, id, counter, theme, FontWeight::SEMIBOLD)).into_any_element()
        }
        Block::List { start, items } => div()
            .flex()
            .flex_col()
            .gap(px(LIST_GAP))
            .children(items.iter().enumerate().map(|(n, item)| {
                let marker: SharedString = match start {
                    Some(first) => format!("{}.", first + n as u64).into(),
                    None => "•".into(),
                };
                div().flex().flex_row().child(div().flex_none().w(px(LIST_MARKER_WIDTH)).text_color(theme.ink3).child(marker)).child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(LIST_GAP))
                        .children(item.iter().map(|block| render_block(block, id, counter, theme))),
                )
            }))
            .into_any_element(),
        Block::Code { text, .. } => code_block(text.clone(), id, counter, theme).into_any_element(),
        Block::Quote(blocks) => div()
            .flex()
            .flex_col()
            .gap(px(BLOCK_GAP))
            .pl(px(12.0))
            .border_l_2()
            .border_color(theme.line_strong)
            .text_color(theme.ink2)
            .children(blocks.iter().map(|block| render_block(block, id, counter, theme)))
            .into_any_element(),
        Block::Rule => div().h(px(1.0)).bg(theme.line).into_any_element(),
    }
}

/// A fenced block: mono 12/18 on `inset`, 1px `line`, 8px radius and padding. Long lines scroll
/// sideways instead of wrapping, like a `<pre>`; vertical wheel deltas are left to the list.
pub fn code_block(text: SharedString, id: usize, counter: &mut usize, theme: &Theme) -> impl IntoElement + use<> {
    *counter += 1;
    let mut scroller = div()
        .id(ElementId::NamedInteger("code".into(), (id * 1000 + *counter) as u64))
        .overflow_x_scroll()
        .flex()
        .w_full()
        .p(px(8.0))
        // A flex child that never shrinks takes its unwrapped width, so the row overflows and scrolls.
        .child(div().flex_none().whitespace_nowrap().child(text));
    scroller.style().restrict_scroll_to_axis = Some(true);
    div()
        .w_full()
        .rounded(RADIUS_CONTROL)
        .bg(theme.inset)
        .border_1()
        .border_color(theme.line)
        .font_family(MONO)
        .text_size(px(CODE_SIZE))
        .line_height(px(CODE_LINE_HEIGHT))
        .text_color(theme.ink)
        .child(scroller)
}

/// The runs for one paragraph: sans at `weight`, bold at 600, inline code in mono on `field`,
/// links in `accent-ink`.
pub fn runs(inline: &Inline, theme: &Theme, weight: FontWeight) -> Vec<TextRun> {
    inline
        .spans
        .iter()
        .map(|span| {
            let mut run_font = font(if span.style.code { MONO } else { SANS });
            run_font.weight = if span.style.bold { FontWeight::SEMIBOLD } else { weight };
            if span.style.italic {
                run_font.style = FontStyle::Italic;
            }
            let color = if span.style.link.is_some() { theme.accent_ink } else { theme.ink };
            TextRun {
                len: span.range.len(),
                font: run_font,
                color: color.into(),
                background_color: span.style.code.then(|| theme.field.into()),
                underline: None,
                strikethrough: None,
            }
        })
        .collect()
}

fn paragraph(inline: &Inline, id: usize, counter: &mut usize, theme: &Theme, weight: FontWeight) -> gpui::AnyElement {
    *counter += 1;
    let text = StyledText::new(inline.text.clone()).with_runs(runs(inline, theme, weight));
    if inline.links.is_empty() {
        return text.into_any_element();
    }
    let ranges: Vec<Range<usize>> = inline.spans.iter().filter(|s| s.style.link.is_some()).map(|s| s.range.clone()).collect();
    let urls: Vec<SharedString> = inline.spans.iter().filter_map(|s| s.style.link.map(|ix| inline.links[ix].clone())).collect();
    InteractiveText::new(ElementId::NamedInteger("prose".into(), (id * 1000 + *counter) as u64), text)
        .on_click(ranges, move |range_ix, _window: &mut Window, cx: &mut App| {
            if let Some(url) = urls.get(range_ix) {
                cx.open_url(url);
            }
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_cover_the_paragraph() {
        let blocks = parse("Plain **bold** and `code` with [a link](https://milagre.cloud).");
        let [Block::Paragraph(inline)] = blocks.as_slice() else { panic!("one paragraph: {blocks:?}") };
        assert_eq!(inline.text.as_ref(), "Plain bold and code with a link.");
        let covered: usize = inline.spans.iter().map(|s| s.range.len()).sum();
        assert_eq!(covered, inline.text.len());
        assert_eq!(inline.links, vec![SharedString::from("https://milagre.cloud")]);
    }

    #[test]
    fn tight_and_nested_lists() {
        let blocks = parse("1. one\n2. two\n   - nested\n");
        let [Block::List { start: Some(1), items }] = blocks.as_slice() else { panic!("{blocks:?}") };
        assert_eq!(items.len(), 2);
        assert!(matches!(items[1].as_slice(), [Block::Paragraph(_), Block::List { start: None, .. }]));
    }
}

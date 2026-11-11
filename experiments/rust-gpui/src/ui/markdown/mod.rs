//! Milagre's markdown (WP-14, WP-15 and the text half of WP-16): gpui-base's rich text view (`TextView`, parsed by
//! markdown-rs with GFM, selectable across blocks and across views through the window's `TextSelection`), styled
//! only from our theme and carrying the rules of `apps/desktop/app/src/components/markdown` as extensions.
//!
//! | Desktop rule (`Markdown.tsx`, `CodeBlock.tsx`, `highlighter.ts`, `streaming-*.ts`) | Here |
//! | --- | --- |
//! | `.markdown` styles in `styles.css` (chat size, em headings, lists, quotes, rules, tables) | [`text_view_style`] |
//! | `CODE_CHIP` inline code | [`text_view_style`] (`with_inline_code_style`) |
//! | `InlineCode`: inline code naming a file is a chip that opens it | [`FileChipPlugin`], [`files`] |
//! | `MarkdownPre` fence routing (markdown, mermaid, openui, code) | [`fences`] |
//! | `CodeBlock` label, Copy, Shiki colours | [`fences::code_actions`], [`highlight`] |
//! | `img`: replies show images as links | [`ImageLinkPlugin`] |
//! | raw HTML shows as text | [`RawHtmlPlugin`] |
//! | `Link`: file links, web links | [`LinkTarget`] |
//! | `splitStreamingBlocks`, `closeOpenMarkdown`, 50 ms throttle | [`stream`]; the transcript streams with them |
//!
//! A view is [`Markdown`] over an `Entity<TextViewState>` the caller keeps (so a message keeps its parse and its
//! selection while it is on screen). Build the style and extensions once and clone them per frame: the text view
//! compares the style by value and keeps its parse while the extensions' parser revision is unchanged.

pub mod fences;
pub mod files;
pub mod highlight;
pub mod stream;

#[cfg(test)]
mod tests;

use std::sync::{Arc, LazyLock};

use gpui::{
    App, ClickEvent, ElementId, FontWeight, InteractiveElement as _, IntoElement, Overflow, ParentElement as _, RenderOnce, SharedString,
    StatefulInteractiveElement as _, StyleRefinement, Styled as _, WhiteSpace, Window, div, px, relative, rems,
};
use gpui_base::{
    InlineElement, InlineRenderContext, MarkdownExtensions, MarkdownNode, MarkdownParseContext, MarkdownPlugin, TextView, TextViewState,
    TextViewStyle, markdown_ast as mdast,
};

use crate::logic::files::file_link::{FileLink, local_file_link};
use crate::theme::component_bridge::COMPONENT_REM;
use crate::theme::{ActiveTheme, Appearance, CHAT_TEXT, CODE_TEXT, RADIUS_CONTROL, RADIUS_INLINE, SANS, Theme, mono};
use files::{FileLinkTarget, file_link_target};

/// The hover group of one message: a code block's Copy shows while the pointer is over its message.
pub const GROUP: &str = "markdown";

/// The chat line height, relative to the chat size (`--chat-size` at 1.6).
const CHAT_LINE: f32 = 1.6;
/// `.markdown h1..h6` sizes in em: 18 / 16 / 15 / 14 at 14px.
const HEADING_EM: [f32; 3] = [18.0 / 14.0, 16.0 / 14.0, 15.0 / 14.0];
/// Headings' line height (`.markdown :where(h1..h6)`).
const HEADING_LINE: f32 = 1.35;
/// `CODE_CHIP`'s `text-[0.875em]`, in px because `rems` in an inline style is the window's rem, not `em`.
const CHIP_EM: f32 = 0.875;
/// The room above a code block's first line: the desktop's 28px header plus its 8px top padding. The language and
/// Copy sit in that band's corner (gpui-base draws a block's actions in its top-right corner, not as a header row).
const CODE_TOP: f32 = 36.0;

/// Px as window rems: gpui-base takes the paragraph gap in rems, and `Root` keeps the rem at [`COMPONENT_REM`].
fn em_rems(px_value: f32) -> gpui::Rems {
    rems(px_value / COMPONENT_REM)
}

/// The text view style for chat text at `size` px (14 by default; user-scaled later), from theme tokens only.
pub fn text_view_style(theme: &Theme, size: f32) -> TextViewStyle {
    let ink = theme.ink;
    let mut chip = StyleRefinement::default().rounded(RADIUS_INLINE).px(px(4.0)).py(px(1.0)).bg(theme.hover2).text_color(ink);
    chip.text.font_family = Some(mono().into());
    chip.text.font_size = Some(px(size * CHIP_EM).into());

    let mut code_block = StyleRefinement::default()
        .rounded(RADIUS_CONTROL)
        .bg(theme.inset)
        .border_1()
        .border_color(theme.line)
        .px(px(12.0))
        .pt(px(CODE_TOP))
        .pb(px(8.0))
        .text_size(px(CODE_TEXT.size))
        .line_height(relative(CHAT_LINE));
    code_block.overflow.x = Some(Overflow::Scroll);
    code_block.text.font_family = Some(mono().into());
    // A `<pre>`: long lines scroll sideways instead of wrapping, and vertical wheel deltas go to the transcript.
    code_block.text.white_space = Some(WhiteSpace::Nowrap);
    code_block.restrict_scroll_to_axis = Some(true);

    let mut table = StyleRefinement::default().text_size(px(12.0));
    table.overflow.x = Some(Overflow::Scroll);
    let table_head = StyleRefinement::default().bg(theme.inset).font_weight(FontWeight::SEMIBOLD);
    let mut table_cell = StyleRefinement::default().border_color(theme.line).px(px(12.0 * 0.65)).py(px(12.0 * 0.3));
    // `overflow-wrap: normal` in the desktop's tables: a cell never breaks inside a word; the table scrolls instead.
    table_cell.text.white_space = Some(WhiteSpace::Nowrap);
    let list = StyleRefinement::default().text_color(theme.ink3);
    let quote = StyleRefinement::default().border_color(theme.line_strong).text_color(theme.ink2).pl(px(size * 0.8));

    TextViewStyle::default()
        .with_foreground(ink.into())
        .with_muted_foreground(theme.ink3.into())
        .with_link(theme.accent_ink.into())
        .with_selection(theme.accent_tint.into())
        .with_code_background(theme.inset.into())
        .with_border(theme.line.into())
        .with_paragraph_gap(em_rems(size * 0.5))
        .with_heading(move |level| {
            let em = HEADING_EM.get(usize::from(level).saturating_sub(1)).copied().unwrap_or(1.0);
            StyleRefinement::default()
                .text_size(px(size * em))
                .line_height(relative(HEADING_LINE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ink)
        })
        .with_inline_code_style(chip)
        .with_code_block(code_block)
        .with_table(table)
        .with_table_head(table_head)
        .with_table_cell(table_cell)
        .with_list_style(list)
        .with_blockquote_style(quote)
        .with_dark(theme.appearance == Appearance::Dark)
}

/// Where a click in markdown goes: `Link` in `Markdown.tsx` and `InlineCode`'s opener.
#[derive(Clone, Debug, PartialEq)]
pub enum LinkTarget {
    /// An `http(s)` link: the Browser panel or the user's browser (Settings › Browser; ⌘-click the other).
    Web(SharedString),
    /// A link to a file on the Chat's computer (`localFileLink`): the file viewer.
    File(FileLink),
    /// Inline code naming a file (`fileLinkTarget`): the editor, at its line.
    Chip(FileLinkTarget),
    /// Any other link (`mailto:` and the like): the system.
    Other(SharedString),
}

impl LinkTarget {
    /// Classifies a link's URL. `root` is the Chat's folder, which relative file links resolve against.
    pub fn of(url: &str, root: Option<&str>) -> Self {
        if let Some(file) = local_file_link(url, root) {
            return LinkTarget::File(file);
        }
        let lower = url.trim_start().to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            LinkTarget::Web(url.to_string().into())
        } else {
            LinkTarget::Other(url.to_string().into())
        }
    }
}

/// What a click on a link, a file chip or an image link does. Shared by every view of a transcript.
pub type LinkHandler = Arc<dyn Fn(&LinkTarget, &ClickEvent, &mut Window, &mut App) + Send + Sync>;

/// Web and other links open with the system; files wait for the file viewer and editor (not ported).
pub fn open_with_system() -> LinkHandler {
    Arc::new(|target, _, _, cx| match target {
        LinkTarget::Web(url) | LinkTarget::Other(url) => cx.open_url(url),
        LinkTarget::File(_) | LinkTarget::Chip(_) => {}
    })
}

/// Inline code that names a file becomes an atomic chip that opens it; copy gives back the code's text.
pub struct FileChipPlugin {
    on_link: LinkHandler,
}

pub const FILE_CHIP: &str = "file-chip";

impl MarkdownPlugin for FileChipPlugin {
    fn name(&self) -> &str {
        FILE_CHIP
    }

    fn parse(&self, node: &mdast::Node, _cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let mdast::Node::InlineCode(code) = node else { return None };
        let target = file_link_target(&code.value)?;
        Some(MarkdownNode::new(FILE_CHIP, target).text(code.value.clone()).markdown(format!("`{}`", code.value)))
    }

    fn render_inline(
        &self,
        node: &MarkdownNode,
        context: &InlineRenderContext,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<InlineElement> {
        let theme = *cx.theme();
        let target = node.data::<FileLinkTarget>()?.clone();
        let on_link = self.on_link.clone();
        let selector = format!("{FILE_CHIP}:{}", target.path);
        let size = context.font_size() * CHIP_EM;
        Some(InlineElement::new(
            div()
                .id(ElementId::Name(selector.clone().into()))
                .debug_selector(move || selector)
                .px(px(4.0))
                .py(px(1.0))
                .rounded(RADIUS_INLINE)
                .bg(theme.hover2)
                .text_color(theme.ink)
                .font_family(mono())
                .text_size(size)
                .cursor_pointer()
                .hover(move |style| style.underline().text_decoration_color(theme.ink3))
                .on_click(move |event, window, cx| on_link(&LinkTarget::Chip(target.clone()), event, window, cx))
                .child(node.as_text().to_string()),
        ))
    }
}

/// Remote images in a reply would load without asking, so the desktop shows them as links (`ImageLink`: the alt
/// text, else the source, else "image"). Same here; clicking goes where the link goes.
pub struct ImageLinkPlugin {
    on_link: LinkHandler,
}

pub const IMAGE_LINK: &str = "image-link";

impl MarkdownPlugin for ImageLinkPlugin {
    fn name(&self) -> &str {
        IMAGE_LINK
    }

    fn parse(&self, node: &mdast::Node, _cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let mdast::Node::Image(image) = node else { return None };
        let label = [image.alt.as_str(), image.url.as_str()].into_iter().find(|text| !text.is_empty()).unwrap_or("image").to_string();
        Some(MarkdownNode::new(IMAGE_LINK, SharedString::from(image.url.clone())).text(label))
    }

    fn render_inline(
        &self,
        node: &MarkdownNode,
        _context: &InlineRenderContext,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<InlineElement> {
        let theme = *cx.theme();
        let url = node.data::<SharedString>()?.clone();
        let on_link = self.on_link.clone();
        Some(InlineElement::new(
            div()
                .id(ElementId::Name(format!("image-link:{url}").into()))
                .debug_selector(|| IMAGE_LINK.into())
                .text_color(theme.accent_ink)
                .underline()
                .text_decoration_color(gpui::Rgba { a: 0.4, ..theme.accent_ink })
                .cursor_pointer()
                .on_click(move |event, window, cx| on_link(&LinkTarget::of(&url, None), event, window, cx))
                .child(node.as_text().to_string()),
        ))
    }
}

/// Raw HTML in a reply is shown as text (react-markdown's default), where gpui-base would render it.
pub struct RawHtmlPlugin;

pub const RAW_HTML: &str = "raw-html";

impl MarkdownPlugin for RawHtmlPlugin {
    fn name(&self) -> &str {
        RAW_HTML
    }

    fn parse(&self, node: &mdast::Node, _cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let mdast::Node::Html(html) = node else { return None };
        Some(MarkdownNode::new(RAW_HTML, ()).text(html.value.clone()))
    }

    fn render_inline(
        &self,
        _node: &MarkdownNode,
        _context: &InlineRenderContext,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<InlineElement> {
        // The text fallback: the source, as text in the line.
        None
    }
}

/// A block of raw HTML, as a paragraph of its source.
fn parse_html_block(node: &mdast::Node, _cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
    let mdast::Node::Html(html) = node else { return None };
    Some(MarkdownNode::new(RAW_HTML, ()).text(html.value.clone()))
}

/// Bumped when a parser rule here changes, so text views parse again; equal across frames otherwise.
const PARSER_REVISION: u64 = 1;

/// Milagre's markdown rules as gpui-base extensions, with `on_link` for chips and image links.
pub fn extensions(on_link: LinkHandler) -> MarkdownExtensions {
    MarkdownExtensions::default()
        .parser_revision(PARSER_REVISION)
        .plugin(FileChipPlugin { on_link: on_link.clone() })
        .plugin(ImageLinkPlugin { on_link })
        .plugin(RawHtmlPlugin)
        .block_parser(fences::parse_fence)
        .block_parser(parse_html_block)
        .block_renderer(fences::NESTED_MARKDOWN, |node, _window, cx| {
            fences::render_nested(node, Arc::new(text_view_style(cx.theme(), CHAT_TEXT.size)))
        })
        .block_renderer(fences::MERMAID, |node, _window, cx| fences::render_placeholder(node, fences::MERMAID, "pele", cx))
        .block_renderer(fences::GENERATIVE_UI, |node, _window, cx| {
            fences::render_placeholder(node, fences::GENERATIVE_UI, "@openuidev/lang-core", cx)
        })
        .block_renderer(RAW_HTML, |node, _window, _cx| div().w_full().whitespace_normal().child(node.as_text().to_string()))
}

/// The extensions with links opening through the system: nested markdown and anything without a transcript.
pub fn base_extensions() -> MarkdownExtensions {
    static BASE: LazyLock<MarkdownExtensions> = LazyLock::new(|| extensions(open_with_system()));
    BASE.clone()
}

/// A markdown message: a selectable text view over `state`, at the chat size, with Milagre's rules.
#[derive(IntoElement)]
pub struct Markdown {
    state: gpui::Entity<TextViewState>,
    style: TextViewStyle,
    extensions: MarkdownExtensions,
    on_link: LinkHandler,
    size: f32,
}

impl Markdown {
    pub fn new(state: &gpui::Entity<TextViewState>, style: TextViewStyle, extensions: MarkdownExtensions, on_link: LinkHandler) -> Self {
        Self { state: state.clone(), style, extensions, on_link, size: CHAT_TEXT.size }
    }

    /// The chat size this view lays out at (the style must have been built for the same size).
    pub fn size(mut self, size: f32) -> Self {
        self.size = size;
        self
    }
}

impl RenderOnce for Markdown {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let on_link = self.on_link;
        div()
            .group(GROUP)
            .w_full()
            .min_w_0()
            .font_family(SANS)
            .text_size(px(self.size))
            .line_height(px(self.size * CHAT_LINE))
            .text_color(theme.ink)
            .child(
                TextView::new(&self.state)
                    .style(self.style)
                    .selectable(true)
                    .markdown_extensions(self.extensions)
                    .code_block_actions(fences::code_actions)
                    .on_link_click(move |url, event, window, cx| on_link(&LinkTarget::of(url, None), event, window, cx)),
            )
    }
}

/// Markdown escaped so it renders as the plain text it is: a user's message shows what they typed (the desktop's
/// `PromptText` renders text, not markdown). Line breaks are kept as hard breaks and blank lines as paragraphs.
pub fn plain_text_source(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            // A backslash before the newline is a hard break; a blank line stays a paragraph break.
            if out.ends_with('\n') || line.trim().is_empty() {
                out.push('\n');
            } else {
                out.push_str("\\\n");
            }
        }
        let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
        for (at, c) in line.char_indices() {
            match c {
                // Entities, so leading whitespace is text and never an indented code block.
                ' ' if at < indent => out.push_str("&#32;"),
                '\t' if at < indent => out.push_str("&#9;"),
                c if c.is_ascii_punctuation() => {
                    out.push('\\');
                    out.push(c);
                }
                c => out.push(c),
            }
        }
    }
    out
}

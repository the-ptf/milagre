//! Probe views for the fit check: a transcript of messages drawn with gpui-component's rich text
//! (`gpui_base::TextView`, which `gpui_component::text::TextView` wraps), carrying Milagre's own
//! markdown rules as extensions, and the text style DESIGN.md asks for.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StyleRefinement, Styled as _, Window, div, px, rems,
};
use gpui_base::text::markdown_ast as mdast;
use gpui_base::{MarkdownExtensions, MarkdownNode, MarkdownParseContext, MarkdownPlugin, TextView, TextViewState, TextViewStyle};

use crate::theme::{ActiveTheme, CHAT_TEXT, RADIUS_CARD, RADIUS_INLINE, SANS, Theme, mono};

/// The desktop's chat text style on gpui-base's `TextViewStyle`: `ink` text, `accent-ink` links, the
/// `accent-tint` selection, the inline code chip of `Markdown.tsx` (`CODE_CHIP`: `rounded-inline
/// bg-hover-2 px-1 font-mono text-[0.875em]`), code blocks on `inset` with `rounded-card`.
pub fn text_style(theme: &Theme) -> TextViewStyle {
    let mut chip = StyleRefinement::default().rounded(RADIUS_INLINE).px(px(4.0)).bg(theme.hover2).text_color(theme.ink);
    chip.text.font_family = Some(mono().into());
    chip.text.font_size = Some(rems(0.875).into());
    let code_block = StyleRefinement::default().rounded(RADIUS_CARD).bg(theme.inset).border_1().border_color(theme.line).p_3();
    TextViewStyle::default()
        .with_foreground(theme.ink.into())
        .with_muted_foreground(theme.ink3.into())
        .with_link(theme.accent_ink.into())
        .with_selection(theme.accent_tint.into())
        .with_code_background(theme.inset.into())
        .with_border(theme.line.into())
        .with_paragraph_gap(rems(0.75))
        .with_inline_code_style(chip)
        .with_code_block(code_block)
        .with_heading(|level| {
            // Markdown headings are em-relative to the chat size (DESIGN.md "Type").
            let size = match level {
                1 => 1.4,
                2 => 1.25,
                3 => 1.1,
                _ => 1.0,
            };
            StyleRefinement::default().text_size(rems(size)).font_weight(FontWeight::SEMIBOLD)
        })
        .with_dark(theme.appearance == crate::theme::Appearance::Dark)
}

/// A file named by inline code, as `lib/file-links.ts` `fileLinkTarget` reads it (simplified: a
/// relative path with a known extension and an optional `:line`).
#[derive(Clone, Debug, PartialEq)]
pub struct FileChip {
    pub path: SharedString,
    pub line: Option<u32>,
}

const EXTENSIONS: &[&str] =
    &["ts", "tsx", "js", "jsx", "mjs", "json", "md", "css", "html", "toml", "yml", "yaml", "rs", "py", "go", "sh", "swift"];

pub fn file_link_target(code: &str) -> Option<FileChip> {
    let (path, line) = match code.rsplit_once(':') {
        Some((path, line)) if line.chars().all(|c| c.is_ascii_digit()) && !line.is_empty() => (path, line.parse().ok()),
        _ => (code, None),
    };
    let ok_chars = path.chars().all(|c| c.is_alphanumeric() || "._-/@+()[]".contains(c));
    if !ok_chars || path.starts_with('/') || path.starts_with('-') || path.ends_with('/') || path.split('/').any(|s| s == "..") {
        return None;
    }
    let name = path.rsplit('/').next()?;
    let (_, extension) = name.rsplit_once('.')?;
    EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()).then(|| FileChip { path: path.to_string().into(), line })
}

/// Inline code that names a file becomes an atomic chip element; copy gives back the code's text.
pub struct FileChipPlugin;

impl MarkdownPlugin for FileChipPlugin {
    fn name(&self) -> &str {
        "file-chip"
    }

    fn parse(&self, node: &mdast::Node, _cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let mdast::Node::InlineCode(code) = node else { return None };
        let chip = file_link_target(&code.value)?;
        Some(MarkdownNode::new("file-chip", chip).text(code.value.clone()).markdown(format!("`{}`", code.value)))
    }

    fn render(&self, node: &MarkdownNode, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let chip = node.data::<FileChip>().cloned().expect("file chip data");
        let selector: &'static str = Box::leak(format!("file-chip:{}", chip.path).into_boxed_str());
        div()
            .id(ElementId::Name(selector.into()))
            .debug_selector(move || selector.into())
            .px(px(4.0))
            .rounded(RADIUS_INLINE)
            .bg(theme.hover2)
            .text_color(theme.ink)
            .font_family(mono())
            .text_size(rems(0.875))
            .cursor_pointer()
            .child(node.as_text().to_string())
    }
}

/// Counts how often the fence parser ran, to show what an append re-parses.
pub type ParseCounter = Arc<AtomicUsize>;

/// Milagre's markdown rules as gpui-base extensions: file chips, and fence routing (`mermaid` to a
/// diagram block, `markdown` to nested markdown), as `MarkdownPre` in `Markdown.tsx` routes them.
pub fn extensions(fence_parses: Option<ParseCounter>) -> MarkdownExtensions {
    MarkdownExtensions::default()
        // A stable parser revision: the closures are rebuilt every frame but parse the same way.
        .parser_revision(7)
        .plugin(FileChipPlugin)
        .block_parser(move |node, _cx| {
            let mdast::Node::Code(code) = node else { return None };
            if let Some(counter) = &fence_parses {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            match code.lang.as_deref() {
                Some("mermaid") => Some(MarkdownNode::new("mermaid", code.value.clone()).text(code.value.clone())),
                Some("markdown" | "md") => Some(MarkdownNode::new("nested-markdown", code.value.clone()).text(code.value.clone())),
                _ => None,
            }
        })
        .block_renderer("mermaid", |node, _window, cx| {
            let theme = cx.theme();
            div()
                .debug_selector(|| "mermaid-block".into())
                .p_3()
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(theme.line)
                .text_color(theme.ink3)
                .child(format!("Mermaid diagram ({} lines): the host renders it to SVG", node.as_text().lines().count()))
        })
        .block_renderer("nested-markdown", |node, _window, _cx| {
            let text = node.data::<String>().cloned().unwrap_or_default();
            div()
                .debug_selector(|| "nested-markdown".into())
                .child(TextView::markdown(ElementId::Name(format!("nested-{}", text.len()).into()), text))
        })
}

/// Link clicks seen by a probe (the handler must be `Send + Sync`).
pub type Clicks = Arc<Mutex<Vec<SharedString>>>;

/// A transcript as one `TextView` per message, under a page-coloured column at the chat text size.
pub struct MessagesView {
    pub messages: Vec<Entity<TextViewState>>,
    pub fence_parses: ParseCounter,
    pub link_clicks: Clicks,
    pub width: gpui::Pixels,
}

impl MessagesView {
    pub fn new(texts: &[&str], cx: &mut Context<Self>) -> Self {
        let messages = texts.iter().map(|text| cx.new(|cx| TextViewState::markdown(text, cx))).collect();
        Self { messages, fence_parses: ParseCounter::default(), link_clicks: Clicks::default(), width: px(640.0) }
    }

    pub fn message(&self, ix: usize) -> Entity<TextViewState> {
        self.messages[ix].clone()
    }
}

impl Render for MessagesView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *cx.theme();
        let style = text_style(&theme);
        let clicks = self.link_clicks.clone();
        let rows: Vec<AnyElement> = self
            .messages
            .iter()
            .enumerate()
            .map(|(ix, state)| {
                let clicks = clicks.clone();
                let selector: &'static str = Box::leak(format!("message-{ix}").into_boxed_str());
                div()
                    .debug_selector(move || selector.into())
                    .w(self.width)
                    .child(
                        TextView::new(state)
                            .style(style.clone())
                            .selectable(true)
                            .markdown_extensions(extensions(Some(self.fence_parses.clone())))
                            .on_link_click(move |url, _, _, _| clicks.lock().expect("clicks").push(url.clone())),
                    )
                    .into_any_element()
            })
            .collect();
        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_4()
            .p_4()
            .bg(theme.page)
            .text_color(theme.ink)
            .font_family(SANS)
            .text_size(px(CHAT_TEXT.size))
            .line_height(px(CHAT_TEXT.line_height))
            .children(rows)
    }
}

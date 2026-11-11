//! Fence routing: `MarkdownPre` in `apps/desktop/app/src/components/markdown/Markdown.tsx`. A fenced block whose
//! first info word is `markdown`/`md` renders as markdown, `mermaid` as a diagram, `openui` as generative UI;
//! everything else is a code block, highlighted when [`resolve_code_language`] knows the fence name
//! (`lib/code-languages.ts`). The diagram and generative UI renderers are other packages in the desktop (`pele`,
//! `@openuidev/lang-core`): here they route to a placeholder block that names the kind and keeps the source.

use std::sync::Arc;

use gpui::{
    App, ElementId, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, SharedString, Styled as _, Window, div, px,
};
use gpui_base::{MarkdownNode, MarkdownParseContext, TextView, TextViewStyle, markdown_ast as mdast};

use super::stream::is_markdown_fence;
use crate::theme::{ActiveTheme, CODE_TEXT, RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, mono};

/// What a fenced block renders as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FenceKind {
    /// `markdown`, `md`: the same formatting as the answer around it.
    Markdown,
    /// `mermaid`: a diagram (`MermaidBlock`, rendered to SVG by `pele` in the desktop).
    Mermaid,
    /// `openui`: generative UI (`GenerativeUI`, parsed by `@openuidev/lang-core`).
    GenerativeUi,
    /// Anything else: a code block (`CodeBlock`).
    Code,
}

impl FenceKind {
    /// `isMarkdownFence`, `isMermaidFence`, `isGenuiFence` in `MarkdownPre`'s order.
    pub fn of(info: Option<&str>) -> Self {
        let first = info.map(|info| crate::logic::copy::js::trim(info).split(crate::logic::copy::js::is_space).next().unwrap_or(""));
        let first = first.map(str::to_lowercase);
        if is_markdown_fence(info) {
            FenceKind::Markdown
        } else if info.is_some_and(|info| crate::logic::copy::js::trim(info).eq_ignore_ascii_case("mermaid")) {
            // `isMermaidFence` compares the whole trimmed name, not its first word.
            FenceKind::Mermaid
        } else if first.as_deref() == Some("openui") {
            FenceKind::GenerativeUi
        } else {
            FenceKind::Code
        }
    }

    /// The custom node name a routed block parses to, or `None` for a plain code block.
    fn node_name(self) -> Option<&'static str> {
        match self {
            FenceKind::Markdown => Some(NESTED_MARKDOWN),
            FenceKind::Mermaid => Some(MERMAID),
            FenceKind::GenerativeUi => Some(GENERATIVE_UI),
            FenceKind::Code => None,
        }
    }
}

pub const NESTED_MARKDOWN: &str = "nested-markdown";
pub const MERMAID: &str = "mermaid";
pub const GENERATIVE_UI: &str = "generative-ui";

/// `CODE_LANGUAGES` in `lib/code-languages.ts`: the 40 Shiki language ids the desktop highlights, each with the
/// fence names that mean it. Anything else renders as plain monospace there.
const CODE_LANGUAGES: &[(&str, &[&str])] = &[
    ("typescript", &["ts", "mts", "cts"]),
    ("tsx", &[]),
    ("javascript", &["js", "mjs", "cjs", "node"]),
    ("jsx", &[]),
    ("json", &["json5"]),
    ("jsonc", &[]),
    ("shellscript", &["bash", "sh", "shell", "zsh"]),
    ("shellsession", &["console", "terminal"]),
    ("python", &["py"]),
    ("go", &["golang"]),
    ("rust", &["rs"]),
    ("swift", &[]),
    ("kotlin", &["kt", "kts"]),
    ("java", &[]),
    ("c", &["h"]),
    ("cpp", &["c++", "cc", "cxx", "hpp"]),
    ("csharp", &["cs", "c#"]),
    ("objective-c", &["objc"]),
    ("ruby", &["rb"]),
    ("php", &[]),
    ("css", &[]),
    ("scss", &[]),
    ("html", &["htm"]),
    ("xml", &["svg", "plist"]),
    ("yaml", &["yml"]),
    ("toml", &[]),
    ("ini", &["conf", "properties"]),
    ("sql", &[]),
    ("diff", &["patch"]),
    ("markdown", &["md"]),
    ("docker", &["dockerfile"]),
    ("make", &["makefile"]),
    ("graphql", &["gql"]),
    ("lua", &[]),
    ("dart", &[]),
    ("elixir", &["ex", "exs"]),
    ("zig", &[]),
    ("prisma", &[]),
    ("powershell", &["ps1", "pwsh"]),
    ("vue", &[]),
    ("svelte", &[]),
];

/// `resolveCodeLanguage`: the Shiki language id a fence name means, or `None` for a block the desktop leaves plain.
pub fn resolve_code_language(name: Option<&str>) -> Option<&'static str> {
    let name = name?.to_lowercase();
    CODE_LANGUAGES.iter().find(|(id, aliases)| *id == name || aliases.contains(&name.as_str())).map(|(id, _)| *id)
}

/// The block parser that routes fences: a `markdown`, `mermaid` or `openui` fence becomes a custom node carrying its
/// source; any other fence is left to the text view's own code block (which the highlighter colours).
pub fn parse_fence(node: &mdast::Node, _cx: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
    let mdast::Node::Code(code) = node else { return None };
    let name = FenceKind::of(code.lang.as_deref()).node_name()?;
    let info = code.lang.clone().unwrap_or_default();
    Some(MarkdownNode::new(name, FencedSource { info: info.into(), code: code.value.clone().into() }).text(code.value.clone()))
}

/// A routed fence's info word and its source.
#[derive(Clone, Debug)]
pub struct FencedSource {
    pub info: SharedString,
    pub code: SharedString,
}

/// A nested `markdown` fence: its source rendered with the same style and rules as the answer, as a view of its own
/// (keyed by the source, so it is parsed once while it stays on screen).
pub fn render_nested(node: &MarkdownNode, style: Arc<TextViewStyle>) -> impl IntoElement + use<> {
    let code = node.data::<FencedSource>().map(|source| source.code.clone()).unwrap_or_default();
    let id = ElementId::Name(format!("nested-markdown-{:x}", fingerprint(&code)).into());
    div()
        .debug_selector(|| NESTED_MARKDOWN.into())
        .w_full()
        .min_w_0()
        .child(TextView::markdown(id, code).style((*style).clone()).markdown_extensions(super::base_extensions()))
}

/// A placeholder for a block whose renderer is another package: the kind named over its source, so nothing is lost.
pub fn render_placeholder(node: &MarkdownNode, kind: &'static str, renderer: &'static str, cx: &App) -> impl IntoElement + use<> {
    let theme = *cx.theme();
    let code = node.data::<FencedSource>().map(|source| source.code.clone()).unwrap_or_default();
    let selector: &'static str = match kind {
        MERMAID => "mermaid-block",
        _ => "generative-ui-block",
    };
    div()
        .debug_selector(move || selector.into())
        .w_full()
        .min_w_0()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .overflow_hidden()
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .px(px(12.0))
                .h(px(28.0))
                .border_b_1()
                .border_color(theme.line)
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child(div().font_family(mono()).child(kind))
                .child(div().font_weight(FontWeight::MEDIUM).child(format!("Rendered by {renderer} in the desktop; not ported"))),
        )
        .child(
            div()
                .px(px(12.0))
                .py(px(8.0))
                .font_family(mono())
                .text_size(px(CODE_TEXT.size))
                .line_height(px(CODE_TEXT.size * 1.6))
                .text_color(theme.ink2)
                .child(code),
        )
}

/// The code block's corner: the fence's language and a Copy button (`CodeBlock.tsx` puts both in its header).
pub fn code_actions(block: &gpui_base::text::CodeBlock, window: &mut Window, cx: &mut App) -> impl IntoElement + use<> {
    let theme = *cx.theme();
    let label: SharedString = block.lang().map(|lang| lang.to_lowercase().into()).unwrap_or_else(|| "text".into());
    let code = block.code();
    // Keyed under the code block's own id (gpui-base scopes the actions per block): the tick after a copy.
    let copied = window.use_keyed_state("copied", cx, |_, _| false);
    let shown = *copied.read(cx);
    let icon = if shown { crate::ui::IconName::Tick02 } else { crate::ui::IconName::Copy01 };
    div()
        .flex()
        .items_center()
        .gap_1()
        .pl(px(8.0))
        .text_step(TEXT_12)
        .text_color(theme.ink3)
        .child(div().font_family(mono()).text_step(TEXT_11).child(label))
        .child(div().opacity(0.0).group_hover(super::GROUP, |style| style.opacity(1.0)).child(
            crate::ui::IconButton::new("copy-code", icon).size(crate::ui::IconButtonSize::S24).on_click(move |_, _, cx| {
                cx.write_to_clipboard(gpui::ClipboardItem::new_string(code.to_string()));
                copied.update(cx, |copied, cx| {
                    *copied = true;
                    cx.notify();
                });
                let copied = copied.downgrade();
                cx.spawn(async move |cx| {
                    cx.background_executor().timer(std::time::Duration::from_millis(COPIED_MS)).await;
                    let _ = copied.update(cx, |copied, cx| {
                        *copied = false;
                        cx.notify();
                    });
                })
                .detach();
            }),
        ))
}

/// How long the tick stays after a copy (`useCopied`).
const COPIED_MS: u64 = 1500;

fn fingerprint(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `code-languages.test.ts`.
    #[test]
    fn fence_names_resolve_to_the_highlighters_language_id() {
        for (name, id) in [
            ("typescript", "typescript"),
            ("ts", "typescript"),
            ("TSX", "tsx"),
            ("sh", "shellscript"),
            ("zsh", "shellscript"),
            ("console", "shellsession"),
            ("yml", "yaml"),
            ("Dockerfile", "docker"),
            ("c++", "cpp"),
            ("patch", "diff"),
        ] {
            assert_eq!(resolve_code_language(Some(name)), Some(id), "{name}");
        }
        for name in [None, Some(""), Some("text"), Some("cobol-2085"), Some("constructor"), Some("__proto__")] {
            assert_eq!(resolve_code_language(name), None, "{name:?}");
        }
    }

    #[test]
    fn fences_route_like_markdown_pre() {
        assert_eq!(FenceKind::of(Some("md")), FenceKind::Markdown);
        assert_eq!(FenceKind::of(Some("Markdown")), FenceKind::Markdown);
        assert_eq!(FenceKind::of(Some(" mermaid ")), FenceKind::Mermaid);
        assert_eq!(FenceKind::of(Some("OpenUI")), FenceKind::GenerativeUi);
        assert_eq!(FenceKind::of(Some("diff")), FenceKind::Code);
        assert_eq!(FenceKind::of(Some("rust")), FenceKind::Code);
        assert_eq!(FenceKind::of(None), FenceKind::Code);
    }
}

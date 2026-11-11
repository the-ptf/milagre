//! Code colours (WP-15): the desktop's Shiki buckets mapped onto gpui-component's syntect highlighter.
//!
//! The desktop highlights with Shiki's CSS-variables theme (`components/markdown/highlighter.ts`): every TextMate
//! scope lands in one of ten `--shiki-*` buckets, and `lib/theme-sheet.ts` fills each bucket with one of the
//! palette's syntax colours (`packages/shared/src/themes/palettes/milagre.ts`, Milagre Blue's `lightSyntax` and
//! `darkSyntax`). gpui-component's syntect backend (feature `syntect`) names what it matched with its own
//! highlight names (`keyword`, `string`, `type`, ...), coarser than TextMate scopes; [`bucket`] sends each name to
//! the Shiki bucket the scopes behind it mostly fall into, and [`highlight_style`] turns that into the
//! `HighlightThemeStyle` gpui-component resolves styles from.
//!
//! [`install`] puts it on gpui-component's theme (whose `TextViewDefaults` hand the highlighter to every text view)
//! and keeps it there on every later theme change. The theme bridge (`theme/component_bridge.rs`) leaves
//! `highlight_theme` alone, so this runs after it.

use std::sync::Arc;

use gpui::{App, Global, Rgba, rgb};
use gpui_component::highlighter::{HighlightTheme, HighlightThemeStyle, SyntaxColors, ThemeStyle};

use crate::theme::{Appearance, Theme};

/// Milagre Blue's syntax colours (`palettes/milagre.ts`). Light and dark only: the other eleven themes come with
/// WP-02's generated palettes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyntaxPalette {
    pub plain: Rgba,
    pub comment: Rgba,
    pub keyword: Rgba,
    pub string: Rgba,
    pub number: Rgba,
    pub function: Rgba,
    pub type_: Rgba,
    pub tag: Rgba,
    pub property: Rgba,
    pub operator: Rgba,
    pub punctuation: Rgba,
}

/// `lightSyntax`.
pub fn light_syntax() -> SyntaxPalette {
    SyntaxPalette {
        plain: rgb(0x24292e),
        comment: rgb(0x6a737d),
        keyword: rgb(0xd73a49),
        string: rgb(0x032f62),
        number: rgb(0x005cc5),
        function: rgb(0x6f42c1),
        type_: rgb(0x005cc5),
        tag: rgb(0x22863a),
        property: rgb(0x005cc5),
        operator: rgb(0xd73a49),
        punctuation: rgb(0x24292e),
    }
}

/// `darkSyntax`.
pub fn dark_syntax() -> SyntaxPalette {
    SyntaxPalette {
        plain: rgb(0xe1e4e8),
        comment: rgb(0x8b949e),
        keyword: rgb(0xf97583),
        string: rgb(0x9ecbff),
        number: rgb(0x79b8ff),
        function: rgb(0xb392f0),
        type_: rgb(0x79b8ff),
        tag: rgb(0x85e89d),
        property: rgb(0x79b8ff),
        operator: rgb(0xf97583),
        punctuation: rgb(0xe1e4e8),
    }
}

pub fn syntax(appearance: Appearance) -> SyntaxPalette {
    match appearance {
        Appearance::Light => light_syntax(),
        Appearance::Dark => dark_syntax(),
    }
}

/// Shiki's CSS-variables buckets (`createCssVariablesTheme`), the ones `theme-sheet.ts` fills.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    /// `--shiki-foreground`: unscoped text, and `markup.inserted/deleted/changed` (their `--shiki-token-*`
    /// variables are never set, so the desktop draws diff lines in the text colour).
    Foreground,
    Comment,
    Keyword,
    /// `--shiki-token-string` and `--shiki-token-string-expression`.
    String,
    /// `--shiki-token-constant`: numbers, `constant.language`, `support.*`, `variable.other.constant`.
    Constant,
    /// `--shiki-token-function`: functions, `entity.name.type`, attribute names.
    Function,
    /// `--shiki-token-parameter`: `variable.parameter.function`.
    Parameter,
    Punctuation,
    /// `--shiki-token-link`: `markup.underline.link`.
    Link,
}

impl Bucket {
    /// `theme-sheet.ts` `SHIKI`: which syntax colour fills the bucket.
    pub fn color(self, palette: &SyntaxPalette) -> Rgba {
        match self {
            Bucket::Foreground => palette.plain,
            Bucket::Comment => palette.comment,
            Bucket::Keyword => palette.keyword,
            Bucket::String => palette.string,
            Bucket::Constant => palette.number,
            Bucket::Function => palette.function,
            Bucket::Parameter => palette.property,
            Bucket::Punctuation => palette.punctuation,
            Bucket::Link => palette.type_,
        }
    }
}

/// The Shiki bucket for one of gpui-component's syntect highlight names (`semantic_name` in its
/// `highlighter/syntect_backend.rs`). Where a name lumps scopes Shiki colours apart, the most frequent scope in agent
/// replies (TypeScript, JavaScript, shell, Rust) decides:
///
/// - `type` is `storage.type` (Shiki: keyword), `entity.name.type` (function) and `support.type`/`support.class`
///   (constant). TypeScript's `string`/`number` annotations are `support.type`: constant.
/// - `property` is mostly `variable.other.property`, which Shiki leaves unscoped: foreground.
/// - `title` (headings) and `label` have no Shiki colour; `tag` is `entity.name.tag`: string-expression.
pub fn bucket(name: &str) -> Bucket {
    match name {
        "comment" | "comment.doc" => Bucket::Comment,
        "string" | "string.escape" | "string.regex" | "string.special" | "string.special.symbol" | "text.literal" | "tag" => Bucket::String,
        "number" | "boolean" | "constant" | "variable.special" | "type" => Bucket::Constant,
        "keyword" | "operator" | "preproc" => Bucket::Keyword,
        "function" | "attribute" | "constructor" => Bucket::Function,
        "punctuation" | "punctuation.bracket" | "punctuation.delimiter" | "punctuation.special" => Bucket::Punctuation,
        "link_uri" | "link_text" => Bucket::Link,
        _ => Bucket::Foreground,
    }
}

/// Every highlight name gpui-component's syntect backend produces.
pub const HIGHLIGHT_NAMES: &[&str] = &[
    "comment",
    "comment.doc",
    "string.escape",
    "string.regex",
    "string",
    "number",
    "boolean",
    "constant",
    "operator",
    "preproc",
    "keyword",
    "type",
    "function",
    "tag",
    "attribute",
    "label",
    "title",
    "variable.special",
    "property",
    "variable",
    "emphasis.strong",
    "emphasis",
    "link_uri",
    "text.literal",
    "punctuation.list_marker",
    "punctuation.bracket",
    "punctuation.delimiter",
    "punctuation",
];

/// gpui-component's theme types are `#[non_exhaustive]` without constructors: styles are copied from its default
/// theme and their fields set.
fn style(name: &str, palette: &SyntaxPalette, template: ThemeStyle) -> Option<ThemeStyle> {
    let mut style = template;
    style.color = Some(bucket(name).color(palette).into());
    style.font_style = None;
    style.font_weight = None;
    Some(style)
}

/// gpui-component's highlight style for an appearance: every name it can produce, coloured by its Shiki bucket.
pub fn highlight_style(appearance: Appearance) -> HighlightThemeStyle {
    let palette = syntax(appearance);
    let defaults = HighlightTheme::default_dark();
    let template = defaults.style.syntax.keyword.or(defaults.style.syntax.comment).expect("gpui-component's default theme styles keywords");
    let s = |name: &str| style(name, &palette, template);
    let mut style = HighlightThemeStyle::default();
    style.editor_foreground = Some(palette.plain.into());
    let mut syntax = SyntaxColors::default();
    syntax.attribute = s("attribute");
    syntax.boolean = s("boolean");
    syntax.comment = s("comment");
    syntax.comment_doc = s("comment.doc");
    syntax.constant = s("constant");
    syntax.constructor = s("constructor");
    syntax.emphasis = s("emphasis");
    syntax.emphasis_strong = s("emphasis.strong");
    syntax.function = s("function");
    syntax.keyword = s("keyword");
    syntax.label = s("label");
    syntax.link_text = s("link_text");
    syntax.link_uri = s("link_uri");
    syntax.number = s("number");
    syntax.operator = s("operator");
    syntax.preproc = s("preproc");
    syntax.property = s("property");
    syntax.punctuation = s("punctuation");
    syntax.punctuation_bracket = s("punctuation.bracket");
    syntax.punctuation_delimiter = s("punctuation.delimiter");
    syntax.punctuation_list_marker = s("punctuation.list_marker");
    syntax.punctuation_special = s("punctuation.special");
    syntax.string = s("string");
    syntax.string_escape = s("string.escape");
    syntax.string_regex = s("string.regex");
    syntax.string_special = s("string.special");
    syntax.string_special_symbol = s("string.special.symbol");
    syntax.tag = s("tag");
    syntax.text_literal = s("text.literal");
    syntax.title = s("title");
    syntax.type_ = s("type");
    syntax.variable = s("variable");
    syntax.variable_special = s("variable.special");
    style.syntax = syntax;
    style
}

/// The highlight theme for an appearance, as gpui-component's theme holds it.
pub fn highlight_theme(appearance: Appearance) -> Arc<HighlightTheme> {
    let mut theme = (*HighlightTheme::default_dark()).clone();
    theme.name = match appearance {
        Appearance::Light => "Milagre Blue Light".into(),
        Appearance::Dark => "Milagre Blue Dark".into(),
    };
    theme.appearance = crate::theme::component_bridge::mode(appearance);
    theme.style = highlight_style(appearance);
    Arc::new(theme)
}

struct Installed;
impl Global for Installed {}

/// Puts the Milagre highlight theme on gpui-component's theme now and after every change of the [`Theme`] global.
/// Idempotent: the transcript calls it when it is created. Needs `gpui_component::init` and the theme bridge first.
pub fn install(cx: &mut App) {
    if cx.has_global::<Installed>() {
        return;
    }
    cx.set_global(Installed);
    apply(cx);
    cx.observe_global::<Theme>(apply).detach();
}

fn apply(cx: &mut App) {
    let appearance = cx.global::<Theme>().appearance;
    gpui_component::Theme::global_mut(cx).highlight_theme = highlight_theme(appearance);
    // Rebuilds the base theme and the text views' defaults, whose code highlighter reads `highlight_theme`.
    gpui_component::Theme::sync_base(cx);
    cx.refresh_windows();
}

#[cfg(test)]
mod tests {
    use gpui::{HighlightStyle, Hsla};
    use gpui_base::input::HighlightStyleResolver as _;

    use super::*;

    #[test]
    fn every_highlight_name_resolves_to_its_bucket_colour() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let theme = highlight_theme(appearance);
            let palette = syntax(appearance);
            for name in HIGHLIGHT_NAMES {
                let expected: Hsla = bucket(name).color(&palette).into();
                let style: Option<HighlightStyle> = theme.style(name);
                assert_eq!(style.and_then(|style| style.color), Some(expected), "{name} in {appearance:?}");
            }
        }
    }

    #[test]
    fn buckets_follow_theme_sheet() {
        let palette = dark_syntax();
        assert_eq!(Bucket::Constant.color(&palette), palette.number, "--shiki-token-constant is `number`");
        assert_eq!(Bucket::Parameter.color(&palette), palette.property);
        assert_eq!(Bucket::Link.color(&palette), palette.type_);
        assert_eq!(bucket("keyword"), Bucket::Keyword);
        assert_eq!(bucket("type"), Bucket::Constant);
        assert_eq!(bucket("variable"), Bucket::Foreground);
    }

    #[gpui::test]
    fn install_puts_the_milagre_theme_on_gpui_component_and_follows_the_appearance(cx: &mut gpui::TestAppContext) {
        crate::testing::init(cx);
        cx.update(install);
        let keyword = |cx: &mut gpui::TestAppContext| {
            cx.update(|cx| gpui_component::Theme::global(cx).highlight_theme.style("keyword").and_then(|style| style.color))
        };
        assert_eq!(keyword(cx), Some(dark_syntax().keyword.into()));
        cx.update(|cx| cx.set_global(Theme::light()));
        assert_eq!(keyword(cx), Some(light_syntax().keyword.into()), "a theme change re-applies it after the bridge");
        assert!(cx.update(|cx| gpui_base::TextViewDefaults::global(cx).has_code_block_highlighter()) == cfg!(feature = "syntect"));
    }
}

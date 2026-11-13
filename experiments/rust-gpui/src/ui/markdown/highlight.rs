//! Code colours (WP-15): the desktop's Shiki buckets mapped onto gpui-component's syntect highlighter.
//!
//! The desktop highlights with Shiki's CSS-variables theme (`components/markdown/highlighter.ts`): every TextMate
//! scope lands in one of ten `--shiki-*` buckets, and `lib/theme-sheet.ts` fills each bucket with one of the
//! palette's syntax colours (`packages/shared/src/themes/palettes/milagre.ts`, Milagre Blue's `lightSyntax` and
//! `darkSyntax`). gpui-component's syntect backend (feature `syntect`) names what it matched with its own
//! highlight names (`keyword`, `string`, `type`, ...), coarser than TextMate scopes; [`bucket`] sends each name to
//! the Shiki bucket the scopes behind it mostly fall into, and [`highlight_style`] turns that into the
//! `HighlightThemeStyle` gpui-component resolves styles from. The colours are the live [`Theme`]'s `syntax`, so a
//! theme switch re-maps them (one rebuild of the highlight theme, no re-parse: the highlighter keeps scopes, and
//! colours are looked up at paint).
//!
//! [`install`] puts it on gpui-component's theme (whose `TextViewDefaults` hand the highlighter to every text view)
//! and keeps it there on every later theme change. The theme bridge (`theme/component_bridge.rs`) leaves
//! `highlight_theme` alone, so this runs after it.

use std::sync::Arc;

use gpui::{App, Global, Rgba};
use gpui_component::highlighter::{HighlightTheme, HighlightThemeStyle, SyntaxColors, ThemeStyle};

use crate::theme::{Appearance, SyntaxColors as ThemeSyntax, Theme};

/// A theme's syntax colours (`ThemePalette.syntax`): they live on the [`Theme`], one set per theme and scheme.
pub type SyntaxPalette = ThemeSyntax;

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
pub fn highlight_style(palette: &SyntaxPalette) -> HighlightThemeStyle {
    let palette = *palette;
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

/// The highlight theme for a theme, as gpui-component's theme holds it.
pub fn highlight_theme(theme: &Theme) -> Arc<HighlightTheme> {
    let mut out = (*HighlightTheme::default_dark()).clone();
    out.name = match theme.appearance {
        Appearance::Light => "Milagre Light".into(),
        Appearance::Dark => "Milagre Dark".into(),
    };
    out.appearance = crate::theme::component_bridge::mode(theme.appearance);
    out.style = highlight_style(&theme.syntax);
    Arc::new(out)
}

struct Installed;
impl Global for Installed {}

/// Puts the Milagre highlight theme on gpui-component's theme now and after every change of the [`Theme`] global
/// (the observer fires on a theme switch only, never per frame).
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
    let highlight = highlight_theme(cx.global::<Theme>());
    gpui_component::Theme::global_mut(cx).highlight_theme = highlight;
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
        for source in [Theme::light(), Theme::dark(), warm_dark()] {
            let theme = highlight_theme(&source);
            let palette = source.syntax;
            for name in HIGHLIGHT_NAMES {
                let expected: Hsla = bucket(name).color(&palette).into();
                let style: Option<HighlightStyle> = theme.style(name);
                assert_eq!(style.and_then(|style| style.color), Some(expected), "{name} in {:?}", source.appearance);
            }
        }
    }

    /// Gruvbox Dark: not Milagre Blue's colours on a dark scheme.
    fn warm_dark() -> Theme {
        crate::settings::appearance::model::palette_for("gruvbox", crate::settings::appearance::palette::Scheme::Dark, None)
            .to_theme(crate::settings::appearance::palette::Scheme::Dark)
    }

    #[test]
    fn buckets_follow_theme_sheet() {
        let palette = Theme::dark().syntax;
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
        assert_eq!(keyword(cx), Some(Theme::dark().syntax.keyword.into()));
        cx.update(|cx| cx.set_global(Theme::light()));
        assert_eq!(keyword(cx), Some(Theme::light().syntax.keyword.into()), "a theme change re-applies it after the bridge");
        cx.update(|cx| cx.set_global(warm_dark()));
        assert_eq!(keyword(cx), Some(warm_dark().syntax.keyword.into()), "a dark theme of another palette recolours it too");
        assert_ne!(warm_dark().syntax.keyword, Theme::dark().syntax.keyword);
        assert!(cx.update(|cx| gpui_base::TextViewDefaults::global(cx).has_code_block_highlighter()) == cfg!(feature = "syntect"));
    }
}

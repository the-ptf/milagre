//! Syntax runs for diff rows (`decorate` in `diff-lines.tsx`): each side of a hunk is highlighted as the text it would
//! be in its own file (context and removed lines for the old side, context and added lines for the new), so strings
//! and comments carry across lines. Colours are the Shiki buckets code blocks use (`ui::markdown::highlight`): the
//! same syntect grammars gpui-component highlights code blocks with, and the same names, mapped to the same buckets.
//!
//! gpui-component keeps its syntect highlighter crate-private, so this runs syntect itself, resumably: a side keeps
//! syntect's parse state where it stopped. The view parses a short hunk in the frame that draws it and a long one on
//! a background thread a chunk at a time (`DiffView::runs_for`): TypeScript costs about 0.25 ms a line here.
//! Only the 40 desktop languages are highlighted (`resolveCodeLanguage`); anything else stays plain, as there.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::LazyLock;

use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use crate::logic::diff::{DiffHunk, LineKind};
use crate::ui::markdown::fences::resolve_code_language;
use crate::ui::markdown::highlight::{Bucket, bucket};

use super::comments::extension_of;

/// Deserialising the grammars takes tens of milliseconds: once, on the first highlighted diff.
static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);

/// How many rows past the one asked for a side parses in one go.
const CHUNK: usize = 160;

/// A line's colour runs: byte ranges of its text and their buckets, ordered, gap-free over the text.
pub type Runs = Vec<(Range<usize>, Bucket)>;

/// The grammar for a file, or `None` when the desktop would leave it plain.
pub fn syntax_for(path: &str) -> Option<&'static SyntaxReference> {
    let extension = extension_of(path);
    let language = resolve_code_language(Some(extension))?;
    let syntaxes = &*SYNTAXES;
    // The file's own extension first (`ts`, `rs`), then the Shiki id and a few ids syntect spells otherwise.
    let alias = match language {
        "shellscript" | "shellsession" => "sh",
        "csharp" => "cs",
        "objective-c" => "m",
        "docker" => "Dockerfile",
        "make" => "Makefile",
        "markdown" => "md",
        "powershell" => "ps1",
        other => other,
    };
    [extension, language, alias]
        .into_iter()
        .find_map(|token| syntaxes.find_syntax_by_token(token))
        .filter(|syntax| syntax.name != "Plain Text")
}

/// The gpui-component highlight name for a TextMate scope (`semantic_name` in its syntect backend: the same names, so
/// `ui::markdown::highlight::bucket` sends them to the same Shiki buckets as code blocks), or `None` to let an
/// enclosing scope decide.
fn name_for(scope: &str) -> Option<&'static str> {
    let is = |prefix: &str| scope == prefix || scope.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('.'));
    const CONTAINERS: &[&str] = &["punctuation.definition.string", "punctuation.definition.comment", "invalid", "meta", "source", "text"];
    if CONTAINERS.iter().any(|p| is(p)) {
        return None;
    }
    const DECLARATIONS: &[&str] =
        &["class", "enum", "function", "impl", "interface", "module", "namespace", "struct", "trait", "type", "let", "var", "const"];
    let table: &[(&[&str], &'static str)] = &[
        (&["comment.block.documentation", "comment.line.documentation"], "comment.doc"),
        (&["comment"], "comment"),
        (&["constant.character.escape"], "string.escape"),
        (&["string.regexp"], "string.regex"),
        (&["string"], "string"),
        (&["constant.numeric"], "number"),
        (&["constant.language.boolean"], "boolean"),
        (&["constant", "support.constant", "entity.name.constant"], "constant"),
        (&["keyword.operator"], "operator"),
        (&["keyword.control.import"], "preproc"),
        (&["keyword", "storage.modifier"], "keyword"),
    ];
    for (prefixes, name) in table {
        if prefixes.iter().any(|p| is(p)) {
            return Some(name);
        }
    }
    if is("storage.type") {
        return Some(if DECLARATIONS.iter().any(|word| scope.contains(word)) { "keyword" } else { "type" });
    }
    let rest: &[(&[&str], &'static str)] = &[
        (&["entity.name.function", "support.function", "variable.function", "meta.function-call"], "function"),
        (
            &[
                "entity.name.type",
                "entity.name.class",
                "entity.name.struct",
                "entity.name.enum",
                "entity.name.trait",
                "entity.name.interface",
                "entity.other.inherited-class",
                "support.type",
                "support.class",
            ],
            "type",
        ),
        (&["entity.name.tag"], "tag"),
        (&["entity.other.attribute-name"], "attribute"),
        (&["entity.name.label"], "label"),
        (&["entity.name.section", "markup.heading"], "title"),
        (&["variable.language"], "variable.special"),
        (&["variable.other.member", "variable.other.property", "support.variable.property", "meta.mapping.key"], "property"),
        (&["variable"], "variable"),
        (&["markup.bold"], "emphasis.strong"),
        (&["markup.italic"], "emphasis"),
        (&["markup.underline.link"], "link_uri"),
        (&["markup.raw"], "text.literal"),
        (&["markup.list"], "punctuation.list_marker"),
        (&["punctuation.section", "punctuation.definition.block"], "punctuation.bracket"),
        (&["punctuation.separator", "punctuation.terminator"], "punctuation.delimiter"),
        (&["punctuation"], "punctuation"),
    ];
    rest.iter().find(|(prefixes, _)| prefixes.iter().any(|p| is(p))).map(|(_, name)| *name)
}

/// The bucket the innermost naming scope gives, `Foreground` when none names anything.
fn bucket_of(scopes: &ScopeStack, names: &mut HashMap<Scope, Option<&'static str>>) -> Bucket {
    scopes
        .scopes
        .iter()
        .rev()
        .find_map(|scope| *names.entry(*scope).or_insert_with(|| name_for(&scope.build_string())))
        .map(bucket)
        .unwrap_or(Bucket::Foreground)
}

/// One side of one hunk, parsed as far as it has been asked for.
pub struct SideHighlighter {
    syntax: &'static SyntaxReference,
    /// Indexes into the hunk's lines that are on this side, in order.
    lines: Vec<usize>,
    parser: ParseState,
    scopes: ScopeStack,
    names: HashMap<Scope, Option<&'static str>>,
    /// Runs by position in `lines`; parsed up to `runs.len()`.
    runs: Vec<Runs>,
}

impl SideHighlighter {
    fn new(syntax: &'static SyntaxReference, lines: Vec<usize>) -> Self {
        Self { syntax, lines, parser: ParseState::new(syntax), scopes: ScopeStack::new(), names: HashMap::new(), runs: Vec::new() }
    }

    /// Parses through position `upto` (and a chunk past it).
    fn ensure(&mut self, hunk: &DiffHunk, upto: usize) {
        let target = (upto + CHUNK).min(self.lines.len());
        let syntaxes = &*SYNTAXES;
        let _ = self.syntax;
        while self.runs.len() < target {
            let text = &hunk.lines[self.lines[self.runs.len()]].text;
            let mut line = String::with_capacity(text.len() + 1);
            line.push_str(text);
            line.push('\n');
            let mut runs: Runs = Vec::new();
            let push = |range: Range<usize>, bucket: Bucket, runs: &mut Runs| {
                let range = range.start.min(text.len())..range.end.min(text.len());
                if range.is_empty() {
                    return;
                }
                match runs.last_mut() {
                    Some((last, b)) if last.end == range.start && *b == bucket => last.end = range.end,
                    _ => runs.push((range, bucket)),
                }
            };
            match self.parser.parse_line(&line, syntaxes) {
                Ok(ops) => {
                    let mut cursor = 0;
                    for (index, op) in ops {
                        let b = bucket_of(&self.scopes, &mut self.names);
                        push(cursor..index, b, &mut runs);
                        let _ = self.scopes.apply(&op);
                        cursor = index;
                    }
                    let b = bucket_of(&self.scopes, &mut self.names);
                    push(cursor..line.len(), b, &mut runs);
                }
                Err(_) => push(0..text.len(), Bucket::Foreground, &mut runs),
            }
            self.runs.push(runs);
        }
    }
}

/// A hunk's two sides.
pub struct HunkHighlighter {
    old: SideHighlighter,
    new: SideHighlighter,
    /// For each hunk line: (side, position in that side). Context lines read the new side, as `decorate` lets its
    /// second pass win.
    place: Vec<(bool, usize)>,
}

impl HunkHighlighter {
    pub fn new(syntax: &'static SyntaxReference, hunk: &DiffHunk) -> Self {
        let mut old = Vec::new();
        let mut new = Vec::new();
        let mut place = Vec::with_capacity(hunk.lines.len());
        for (ix, line) in hunk.lines.iter().enumerate() {
            match line.kind {
                LineKind::Remove => {
                    place.push((false, old.len()));
                    old.push(ix);
                }
                LineKind::Add => {
                    place.push((true, new.len()));
                    new.push(ix);
                }
                LineKind::Context => {
                    old.push(ix);
                    place.push((true, new.len()));
                    new.push(ix);
                }
            }
        }
        Self { old: SideHighlighter::new(syntax, old), new: SideHighlighter::new(syntax, new), place }
    }

    /// The runs of hunk line `ix`, parsing as far as needed.
    pub fn runs(&mut self, hunk: &DiffHunk, ix: usize) -> Option<&Runs> {
        let (new_side, pos) = *self.place.get(ix)?;
        let side = if new_side { &mut self.new } else { &mut self.old };
        if side.runs.len() <= pos {
            side.ensure(hunk, pos);
        }
        side.runs.get(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::diff::parse_patch;

    #[test]
    fn typescript_rows_get_keyword_and_string_buckets() {
        let syntax = syntax_for("src/a.ts").expect("TypeScript is a desktop language");
        let hunks = parse_patch("@@ -1,1 +1,2 @@\n-const a = 1;\n+const a = \"x\";\n+// note\n");
        let mut h = HunkHighlighter::new(syntax, &hunks[0]);
        let line = &hunks[0].lines[1].text;
        let runs = h.runs(&hunks[0], 1).unwrap().clone();
        let at = |needle: &str| {
            let start = line.find(needle).unwrap();
            runs.iter().find(|(r, _)| r.start <= start && start < r.end).map(|(_, b)| *b)
        };
        assert_eq!(at("const"), Some(Bucket::Keyword));
        assert_eq!(at("\"x\""), Some(Bucket::String));
        assert_eq!(runs.last().unwrap().0.end, line.len(), "runs cover the text");
        let comment = h.runs(&hunks[0], 2).unwrap().clone();
        assert_eq!(comment[0].1, Bucket::Comment);
    }

    #[test]
    fn unknown_and_plain_files_are_not_highlighted() {
        assert!(syntax_for("notes.unknownext").is_none());
        assert!(syntax_for("Cargo.lock").is_none());
        assert!(syntax_for("src/main.rs").is_some());
        assert!(syntax_for("README.md").is_some());
    }

    #[test]
    fn a_side_parses_lazily_in_chunks() {
        let syntax = syntax_for("a.rs").unwrap();
        let body: String = (0..2000).map(|i| format!("+let x{i} = {i};\n")).collect();
        let hunks = parse_patch(&format!("@@ -0,0 +1,2000 @@\n{body}"));
        let mut h = HunkHighlighter::new(syntax, &hunks[0]);
        h.runs(&hunks[0], 5);
        assert_eq!(h.new.runs.len(), 5 + CHUNK, "only a chunk past the row asked for");
        h.runs(&hunks[0], 1500);
        assert_eq!(h.new.runs.len(), 1500 + CHUNK);
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use crate::logic::diff::parse_patch;

    /// `cargo test --release -- --ignored --nocapture highlight_rate`: how long syntect takes per line.
    #[test]
    #[ignore]
    fn highlight_rate() {
        for (path, line) in [
            ("a.ts", "export const value1 = compute(1, \"label 1\") // line 1"),
            ("a.rs", "let value1 = compute(1, \"label 1\"); // line 1"),
        ] {
            let body: String = (0..2000).map(|_| format!("+{line}\n")).collect();
            let hunks = parse_patch(&format!("@@ -0,0 +1,2000 @@\n{body}"));
            let _ = syntax_for(path);
            let started = std::time::Instant::now();
            let mut h = HunkHighlighter::new(syntax_for(path).unwrap(), &hunks[0]);
            h.runs(&hunks[0], 1999 - CHUNK);
            eprintln!("highlight: {path} {:.3} ms per line", started.elapsed().as_secs_f64() * 1000.0 / 2000.0);
        }
    }
}

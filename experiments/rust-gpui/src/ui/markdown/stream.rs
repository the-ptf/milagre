//! The streaming rules of the desktop's markdown, ported line for line so a live answer splits and closes the way
//! Electron and the phone do:
//!
//! - [`split_streaming_blocks`] is `packages/shared/src/streaming-blocks.ts` `splitStreamingBlocks`: a streaming
//!   answer cut into top-level blocks at blank lines outside code fences, so the finished blocks keep their parse and
//!   only the block being written is parsed again. Like the TypeScript, it continues from the previous batch of the
//!   same answer instead of rescanning the whole text ([`StreamSplitter`] keeps the last eight answers).
//! - [`close_open_markdown`] is `streaming-markdown.ts` `closeOpenMarkdown`: the open bold or code span of the
//!   paragraph being written is closed (or a lone marker dropped) so the formatting holds still while it streams.
//! - [`is_markdown_fence`] is `markdown-fence.ts`.
//!
//! Offsets are UTF-8 bytes where the TypeScript counts UTF-16 units; both only ever slice the same text at line
//! starts, so the blocks are the same. JavaScript's `trim` and `\s` come from `logic::copy::js`.

use std::cell::RefCell;

use crate::logic::copy::js;

/// `isMarkdownFence`: a fence whose first word is `markdown` or `md`, in any case.
pub fn is_markdown_fence(info: Option<&str>) -> bool {
    let language = info.and_then(|info| js::trim(info).split(js::is_space).next()).map(str::to_lowercase);
    matches!(language.as_deref(), Some("markdown" | "md"))
}

/// `/^ {0,3}(`{3,}|~{3,})/`: the fence marker a line opens or closes with.
fn fence_marker(line: &str) -> Option<&str> {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let first = rest.bytes().next().filter(|b| *b == b'`' || *b == b'~')?;
    let run = rest.bytes().take_while(|b| *b == first).count();
    (run >= 3).then(|| &rest[..run])
}

/// `/^([-*+]|\d{1,9}[.)])( |\t|$)/`: a line that opens a list item.
fn is_list_item(line: &str) -> bool {
    let bytes = line.as_bytes();
    let after = match bytes.first() {
        Some(b'-' | b'*' | b'+') => 1,
        Some(b) if b.is_ascii_digit() => {
            let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
            if digits > 9 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return false;
            }
            digits + 1
        }
        _ => return false,
    };
    matches!(bytes.get(after), None | Some(b' ' | b'\t'))
}

/// `/^ {0,3}\[[^\]]+\]:|^ {0,3}<(?:pre|script|style|textarea)\b/im`: a reference definition, or a raw HTML block
/// that may hold blank lines, starting on any line of `text`. As in JavaScript, `[^\]]` also matches newlines, so
/// a label may run over several lines.
fn is_unsplittable(text: &str) -> bool {
    let mut line_start = 0;
    loop {
        let line = &text[line_start..];
        let indent = line.bytes().take_while(|b| *b == b' ').count();
        if indent <= 3 {
            let rest = &line[indent..];
            if let Some(label) = rest.strip_prefix('[')
                && let Some(close) = label.find(']')
                && close > 0
                && label[close + 1..].starts_with(':')
            {
                return true;
            }
            if let Some(tag) = rest.strip_prefix('<') {
                for name in ["pre", "script", "style", "textarea"] {
                    let matches_name = tag.get(..name.len()).is_some_and(|head| head.eq_ignore_ascii_case(name));
                    // `\b`: the name ends where a word character does not follow it.
                    if matches_name && !tag[name.len()..].chars().next().is_some_and(js::is_word) {
                        return true;
                    }
                }
            }
        }
        match text[line_start..].find('\n') {
            Some(newline) => line_start += newline + 1,
            None => return false,
        }
    }
}

fn is_blank(line: &str) -> bool {
    js::trim(line).is_empty()
}

/// What one split learned about a text, kept so the next batch of the same answer (which starts with this text)
/// only scans what it added. Every field holds for any text that starts with `text`.
#[derive(Clone, Debug, Default)]
struct SplitState {
    text: String,
    /// Where the text's last line starts: the lines before it are complete and can no longer change.
    last_line: usize,
    /// A complete line is a reference definition or opens a raw HTML block, so the text stays whole from now on.
    unsplittable: bool,
    double_newline: bool,
    /// Where the last block whose first line is complete starts; the blocks before it are final.
    resume_at: usize,
    before: Vec<String>,
    blocks: Vec<String>,
}

impl SplitState {
    fn empty() -> Self {
        Self { blocks: vec![String::new()], ..Self::default() }
    }
}

struct Scan {
    blocks: Vec<String>,
    resume_at: usize,
    before: Vec<String>,
}

/// Scans `text` from `from` (a line start where a block starts, or 0) on, after the final blocks `before`.
fn scan(text: &str, from: usize, before: &[String]) -> Scan {
    let lines: Vec<&str> = text[from..].split('\n').collect();
    let mut blocks = before.to_vec();
    let mut resume_at = from;
    let mut resume_before = before.to_vec();
    let mut start = 0;
    let mut offset = from;
    let mut fence: Option<&str> = None;
    let mut blank_before = false;
    let mut in_list = false;
    for (index, line) in lines.iter().enumerate() {
        let line_offset = offset;
        offset += line.len() + 1;
        let marker = fence_marker(line);
        if let Some(open) = fence {
            if let Some(marker) = marker
                && marker.as_bytes()[0] == open.as_bytes()[0]
                && marker.len() >= open.len()
                && js::trim(line) == marker
            {
                fence = None;
            }
            continue;
        }
        if is_blank(line) {
            blank_before = true;
            continue;
        }
        let item = is_list_item(line);
        // An indented line continues the block before the blank line (code or a list body), and so does a list
        // item in a list.
        let starts_flush = line.chars().next().is_some_and(|c| !js::is_space(c));
        if blank_before && starts_flush && !(item && in_list) {
            // The blank lines between blocks belong to neither.
            let mut end = index;
            while end > start && is_blank(lines[end - 1]) {
                end -= 1;
            }
            blocks.push(lines[start..end].join("\n"));
            start = index;
            in_list = false;
            // A block whose first line is complete starts there for good: what follows can't change its verdict.
            if index < lines.len() - 1 {
                resume_at = line_offset;
                resume_before = blocks.clone();
            }
        }
        if item {
            in_list = true;
        }
        blank_before = false;
        if marker.is_some() {
            fence = marker;
        }
    }
    blocks.push(lines[start..].join("\n"));
    Scan { blocks, resume_at, before: resume_before }
}

fn next(previous: &SplitState, text: &str) -> SplitState {
    let last_line = text.rfind('\n').map_or(0, |at| at + 1);
    // Only the lines completed since the previous split still need the whole-text checks.
    let unsplittable = previous.unsplittable || (last_line > previous.last_line && is_unsplittable(&text[previous.last_line..last_line]));
    // `text.includes("\n\n", previous.length - 1)`: from the previous text's last character on.
    let mut search_from = previous.text.len().saturating_sub(1);
    while !text.is_char_boundary(search_from) {
        search_from -= 1;
    }
    let double_newline = previous.double_newline || text[search_from..].contains("\n\n");
    let mut state = SplitState {
        text: text.to_string(),
        last_line,
        unsplittable,
        double_newline,
        resume_at: previous.resume_at,
        before: previous.before.clone(),
        blocks: Vec::new(),
    };
    if !double_newline || unsplittable || is_unsplittable(&text[last_line..]) {
        state.blocks = vec![text.to_string()];
        return state;
    }
    let scan = scan(text, previous.resume_at, &previous.before);
    state.blocks = scan.blocks;
    state.resume_at = scan.resume_at;
    state.before = scan.before;
    state
}

/// A few answers can stream at once (split view, background Chats), so each keeps its own state.
const RECENT_LIMIT: usize = 8;

/// The split states of the last [`RECENT_LIMIT`] texts, most recent first: `streaming-blocks.ts`'s `recent`.
#[derive(Default)]
pub struct StreamSplitter {
    recent: Vec<SplitState>,
}

impl StreamSplitter {
    /// The text as consecutive top-level blocks, split at blank lines outside code fences. Joined with blank lines
    /// they read as the text.
    pub fn split(&mut self, text: &str) -> Vec<String> {
        // While an answer streams each text starts with the previous one: continue from there instead of rescanning.
        let mut found: Option<usize> = None;
        for (index, candidate) in self.recent.iter().enumerate() {
            let longer = found.is_none_or(|found| candidate.text.len() > self.recent[found].text.len());
            if text.len() >= candidate.text.len() && text.starts_with(candidate.text.as_str()) && longer {
                found = Some(index);
            }
        }
        let state = match found {
            Some(index) if self.recent[index].text == text => self.recent.remove(index),
            Some(index) => {
                let previous = self.recent.remove(index);
                next(&previous, text)
            }
            None => next(&SplitState::empty(), text),
        };
        let blocks = state.blocks.clone();
        self.recent.insert(0, state);
        self.recent.truncate(RECENT_LIMIT);
        blocks
    }
}

thread_local! {
    static SPLITTER: RefCell<StreamSplitter> = RefCell::new(StreamSplitter::default());
}

/// `splitStreamingBlocks`, with one shared cache of recent answers per thread as the module-level cache in
/// TypeScript.
pub fn split_streaming_blocks(text: &str) -> Vec<String> {
    SPLITTER.with(|splitter| splitter.borrow_mut().split(text))
}

/// `/^ {0,3}([*_-])( *\1){2,} *$/`: a thematic break line.
fn is_thematic_break(line: &str) -> bool {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return false;
    }
    let rest = line[indent..].trim_end_matches(' ');
    let Some(mark) = rest.bytes().next().filter(|b| matches!(b, b'*' | b'_' | b'-')) else { return false };
    let marks = rest.bytes().filter(|b| *b == mark).count();
    rest.bytes().all(|b| b == mark || b == b' ') && marks >= 3
}

/// `/(?<!`)`(?!`)/g`: single backticks, not part of a longer run.
fn single_ticks(text: &str) -> usize {
    let bytes = text.as_bytes();
    (0..bytes.len())
        .filter(|&at| bytes[at] == b'`' && (at == 0 || bytes[at - 1] != b'`') && bytes.get(at + 1).is_none_or(|next| *next != b'`'))
        .count()
}

/// `text.replace(/`[^`]*`/g, "")`: the text without its code spans.
fn without_code_spans(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('`') {
        match rest[open + 1..].find('`') {
            Some(close) => {
                out.push_str(&rest[..open]);
                rest = &rest[open + 1 + close + 1..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

/// `/(^|\s)\*$/`: the text ends in a lone `*` (at its start or after whitespace).
fn ends_in_lone_star(text: &str) -> bool {
    let Some(before) = text.strip_suffix('*') else { return false };
    before.chars().next_back().is_none_or(js::is_space)
}

/// `closeOpenMarkdown`: while a reply streams, a bold phrase or inline code span stays open until its closing
/// marker arrives, and Markdown shows the raw marker meanwhile. Closing it in the live text keeps the formatting
/// steady. Saved replies render as written.
pub fn close_open_markdown(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut fence: Option<&str> = None;
    let mut paragraph_start = 0;
    for (index, line) in lines.iter().enumerate() {
        let marker = fence_marker(line);
        if let Some(open) = fence {
            if let Some(marker) = marker
                && marker.as_bytes()[0] == open.as_bytes()[0]
                && marker.len() >= open.len()
                && js::trim(line) == marker
            {
                fence = None;
                paragraph_start = index + 1;
            }
            continue;
        }
        if marker.is_some() {
            fence = marker;
        } else if is_blank(line) {
            paragraph_start = index + 1;
        }
    }
    // An open fence already renders as a code block running to the end of the text.
    if fence.is_some() {
        return text.to_string();
    }
    // A lone `*` just streamed in starts emphasis or a bullet; hide it until the next chunk shows which.
    if ends_in_lone_star(text) {
        return close_open_markdown(&text[..text.len() - 1]);
    }
    // Emphasis and code spans never cross a blank line, so only the paragraph being written can hold an open marker.
    let paragraph = lines
        .get(paragraph_start..)
        .unwrap_or_default()
        .iter()
        .filter(|line| !is_thematic_break(line))
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    if single_ticks(&paragraph) % 2 == 1 {
        return match text.strip_suffix('`') {
            Some(open) => open.to_string(),
            None => format!("{text}`"),
        };
    }
    let bold = without_code_spans(&paragraph).matches("**").count();
    // A closing marker must touch the text it closes, so trailing spaces go first.
    if bold % 2 == 1 {
        let trimmed = js::trim_end_js(text);
        return match trimmed.strip_suffix("**") {
            Some(open) => open.to_string(),
            None => format!("{trimmed}**"),
        };
    }
    text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(text: &str) -> Vec<String> {
        split_streaming_blocks(text)
    }

    fn strings(blocks: &[&str]) -> Vec<String> {
        blocks.iter().map(|block| block.to_string()).collect()
    }

    /// What every split must equal: the whole text scanned from the start, with no state carried between calls
    /// (`fullSplit` in both `streaming-blocks.test.ts` files).
    fn full_split(text: &str) -> Vec<String> {
        if !text.contains("\n\n") || is_unsplittable(text) {
            return vec![text.to_string()];
        }
        scan(text, 0, &[]).blocks
    }

    // `packages/shared/src/streaming-blocks.test.ts`.
    const SHARED_TEXTS: [&str; 5] = [
        "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter\n\n~~~\nx\n\n```\nstill tilde\n~~~\n\n````md\n```js\ninner\n```\n\nouter\n````\n\n```sh\n\nopen",
        "Lead\n\n- a\n\n- b\n\n  body\n\n* c\n\n1. one\n\n2) two\n\n10. ten\n\nTail\n\n3\n\n3. item\n\n+ plus\n\nDone",
        "See [docs] and [api]\n\nMore\n\n[docs]: https://example.test\n\n[api]: <https://api.test> \"Title\"\n\nAfter",
        "Before\n\n<prefix stays\n\n<script>\na\n\nb\n</script>\n\nEnd",
        "Para\n\n    code\n\n    more\n\n> quote\n> more\n\n## Heading\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\n",
    ];

    // `apps/desktop/app/src/components/markdown/streaming-blocks.test.ts`.
    const DESKTOP_STREAMED: [&str; 6] = [
        "Intro line\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the fence\n\n~~~\nx\n\n```\nstill tilde\n~~~\n\nEnd",
        "Lead\n\n- a\n\n- b\n\n  body\n\n- c\n\n1. one\n\n2. two\n\n10) ten\n\nTail\n\n1\n\n1. late item\n\nDone",
        "See [docs]\n\nMore text\n\n[docs]: https://example.test\n\nAfter",
        "Before\n\n<pre>\na\n\nb\n</pre>\n\nAfter <prefix stays\n\n<pres not html\n\nEnd",
        "Para\n\n    indented code\n\n    more\n\n> quote\n\n## Heading\n\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n",
        "````md\n```js\ninner\n```\n\nstill outer\n````\n\nout\n\n```open forever\n\nnever closes",
    ];

    fn char_prefixes(text: &str) -> impl Iterator<Item = &str> {
        text.char_indices().map(|(at, _)| &text[..at]).chain(std::iter::once(text))
    }

    #[test]
    fn every_prefix_of_a_streamed_text_splits_as_the_whole_text_would() {
        for text in SHARED_TEXTS.iter().chain(DESKTOP_STREAMED.iter()) {
            for prefix in char_prefixes(text) {
                assert_eq!(split(prefix), full_split(prefix), "prefix {prefix:?}");
            }
        }
    }

    /// Both TypeScript files' interleaving tests: several answers, uneven batches, each split as a whole.
    #[test]
    fn several_answers_streaming_at_once_in_uneven_batches_each_split_as_a_whole() {
        for (texts, a, b, modulo) in [(&SHARED_TEXTS[..], 5, 7, 13), (&DESKTOP_STREAMED[..], 7, 3, 11)] {
            let mut cursors = vec![0usize; texts.len()];
            let mut step = 0;
            while cursors.iter().zip(texts).any(|(cursor, text)| *cursor < text.len()) {
                for (index, text) in texts.iter().enumerate() {
                    cursors[index] = (cursors[index] + 1 + (step * a + index * b) % modulo).min(text.len());
                    let prefix = &text[..cursors[index]];
                    assert_eq!(split(prefix), full_split(prefix), "prefix {prefix:?}");
                }
                step += 1;
            }
        }
        // A text that doesn't continue the previous one (an edit, a new answer) is split from scratch.
        assert_eq!(split("Fresh\n\nstart"), strings(&["Fresh", "start"]));
        assert_eq!(split("Fresh\n\nstart"), strings(&["Fresh", "start"]));
    }

    #[test]
    fn finished_blocks_are_final_and_the_blank_lines_between_blocks_belong_to_neither() {
        assert_eq!(split("One\n\n```\na\n\nb\n```\n\n- x\n\n- y\n\nEnd"), strings(&["One", "```\na\n\nb\n```", "- x\n\n- y", "End"]));
        let mut blocks = split("Alpha\n\nBeta");
        blocks.push("mutated".into());
        assert_eq!(split("Alpha\n\nBeta"), strings(&["Alpha", "Beta"]));
        assert_eq!(split("Alpha\n\nGamma"), strings(&["Alpha", "Gamma"]));
    }

    #[test]
    fn splits_at_blank_lines_between_top_level_blocks() {
        assert_eq!(split("One\n\nTwo\nstill two\n\n\n## Three"), strings(&["One", "Two\nstill two", "## Three"]));
        assert_eq!(split("single paragraph\nwith a break"), strings(&["single paragraph\nwith a break"]));
        // A blank line inside an open or closed fence is no boundary.
        assert_eq!(split("Intro\n\n```js\na\n\nb\n```\n\nAfter"), strings(&["Intro", "```js\na\n\nb\n```", "After"]));
        assert_eq!(split("Intro\n\n```js\na\n\nb"), strings(&["Intro", "```js\na\n\nb"]));
        // A list keeps its items and indented bodies together.
        let list = "- a\n\n- b\n\n  body\n\n- c";
        assert_eq!(split(&format!("Lead\n\n{list}\n\nTail")), strings(&["Lead", list, "Tail"]));
        assert_eq!(split("1. a\n\n2. b"), strings(&["1. a\n\n2. b"]));
        // Trailing blank lines stay out of the last block.
        assert_eq!(split("One\n\n"), strings(&["One\n\n"]));
        assert_eq!(split("One\n\nTwo\n\n"), strings(&["One", "Two\n\n"]));
        // Text with reference definitions or raw HTML blocks is left whole.
        assert_eq!(split("See [a]\n\n[a]: https://x.test").len(), 1);
        assert_eq!(split("<pre>\na\n\nb\n</pre>\n\nAfter").len(), 1);
        // Blocks rejoined with blank lines match the text without its extra blank lines.
        let text = "Intro\n\n- a\n- b\n\n```sh\nx\n\ny\n```\n\n> quote\n\nEnd";
        assert_eq!(split(text).join("\n\n"), text);
    }

    #[test]
    fn fences_lists_and_reference_definitions_that_arrive_later_change_the_split_like_a_whole_text_split() {
        assert_eq!(split("- a\n\n1"), strings(&["- a", "1"]));
        assert_eq!(split("- a\n\n1."), strings(&["- a\n\n1."]));
        assert_eq!(split("Intro\n\n``"), strings(&["Intro", "``"]));
        assert_eq!(split("Intro\n\n```\na\n\nb"), strings(&["Intro", "```\na\n\nb"]));
        assert_eq!(split("One\n\nTwo\n\n[x"), strings(&["One", "Two", "[x"]));
        assert_eq!(split("One\n\nTwo\n\n[x]: https://x.test"), strings(&["One\n\nTwo\n\n[x]: https://x.test"]));
        assert_eq!(split("One\n\nTwo\n\n[x]: https://x.test\n\nThree"), strings(&["One\n\nTwo\n\n[x]: https://x.test\n\nThree"]));
        assert_eq!(split("A\n\n<pre"), strings(&["A\n\n<pre"]));
        assert_eq!(split("A\n\n<prefix"), strings(&["A", "<prefix"]));
    }

    /// `apps/desktop/app/src/lib/streaming-markdown.test.ts`, every case.
    #[test]
    fn close_open_markdown_matches_the_typescript_vectors() {
        let cases = [
            // Finished text is left alone.
            ("Some **bold** and `code`.", "Some **bold** and `code`."),
            ("", ""),
            // Bold that is still streaming renders as bold.
            ("This demonstrates **bold te", "This demonstrates **bold te**"),
            ("- item\n- **Claude:** done and **more", "- item\n- **Claude:** done and **more**"),
            // Inline code that is still streaming renders as code, and bold inside it is not closed.
            ("Run `npm run", "Run `npm run`"),
            ("Run `a **b", "Run `a **b`"),
            ("Use `x` and **y", "Use `x` and **y**"),
            // A marker with nothing after it yet is dropped instead of closed.
            ("This is **", "This is "),
            ("Run `", "Run "),
            ("This is a **bold statement** with *", "This is a **bold statement** with "),
            ("**open text *", "**open text**"),
            ("Now **bold ", "Now **bold**"),
            ("- a\n*", "- a\n"),
            ("2 * 3", "2 * 3"),
            // Open code fences are left for the renderer, and fenced code is never counted.
            ("```ts\nconst a = `x", "```ts\nconst a = `x"),
            ("```\na ** b\n```\nNow **bold", "```\na ** b\n```\nNow **bold**"),
            // Only the paragraph being written is considered.
            ("Odd ** in an old paragraph\n\nNew text", "Odd ** in an old paragraph\n\nNew text"),
            // Thematic breaks and list bullets are not bold markers.
            ("Above\n***\nBelow", "Above\n***\nBelow"),
            ("* one\n* two", "* one\n* two"),
        ];
        for (input, expected) in cases {
            assert_eq!(close_open_markdown(input), expected, "{input:?}");
        }
    }

    #[test]
    fn markdown_fences_are_md_or_markdown() {
        assert!(is_markdown_fence(Some("markdown")));
        assert!(is_markdown_fence(Some(" MD extra")));
        assert!(!is_markdown_fence(Some("mdx")));
        assert!(!is_markdown_fence(None));
    }
}

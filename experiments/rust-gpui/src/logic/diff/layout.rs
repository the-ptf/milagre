//! `diff-layout.ts`: split rows and word-level changes.

use super::parse::{DiffHunk, DiffLine, LineKind};
use super::{is_js_space, utf16_len};

/// One row of the split view: old on the left, new on the right. A context line is on both sides; a missing side is
/// an empty cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitRow<'a> {
    pub left: Option<&'a DiffLine>,
    pub right: Option<&'a DiffLine>,
}

/// A half-open character range `[start, end)`, counted in UTF-16 code units like the TS's string offsets. Use
/// [`utf16_range_to_bytes`] to slice a Rust string with one.
pub type Range = (usize, usize);

/// Old on the left, new on the right; each block of removals is paired with the additions that follow it.
pub fn split_rows(hunk: &DiffHunk) -> Vec<SplitRow<'_>> {
    let mut rows = Vec::new();
    let mut removed: Vec<&DiffLine> = Vec::new();
    let mut added: Vec<&DiffLine> = Vec::new();
    fn flush<'a>(rows: &mut Vec<SplitRow<'a>>, removed: &mut Vec<&'a DiffLine>, added: &mut Vec<&'a DiffLine>) {
        for i in 0..removed.len().max(added.len()) {
            rows.push(SplitRow { left: removed.get(i).copied(), right: added.get(i).copied() });
        }
        removed.clear();
        added.clear();
    }
    for line in &hunk.lines {
        match line.kind {
            LineKind::Context => {
                flush(&mut rows, &mut removed, &mut added);
                rows.push(SplitRow { left: Some(line), right: Some(line) });
            }
            LineKind::Remove => {
                // A removal after additions starts a new block.
                if !added.is_empty() {
                    flush(&mut rows, &mut removed, &mut added);
                }
                removed.push(line);
            }
            LineKind::Add => added.push(line),
        }
    }
    flush(&mut rows, &mut removed, &mut added);
    rows
}

const MAX_WORD_DIFF_CHARS: usize = 500;
const MIN_SIMILARITY: f64 = 0.4;

/// JavaScript's `\w`: ASCII letters, digits and underscore (the `u` flag does not widen it).
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `text.match(/\w+|\s+|[^\w\s]/gu)`: runs of word characters, runs of whitespace, single other code points.
fn tokenize(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        let mut end = start + c.len_utf8();
        let same: fn(char) -> bool = if is_word(c) {
            is_word
        } else if is_js_space(c) {
            is_js_space
        } else {
            tokens.push(&text[start..end]);
            continue;
        };
        while let Some(&(i, next)) = chars.peek() {
            if !same(next) {
                break;
            }
            end = i + next.len_utf8();
            chars.next();
        }
        tokens.push(&text[start..end]);
    }
    tokens
}

fn merge(ranges: Vec<Range>) -> Vec<Range> {
    let mut out: Vec<Range> = Vec::new();
    for range in ranges {
        match out.last_mut() {
            Some(last) if last.1 == range.0 => last.1 = range.1,
            _ => out.push(range),
        }
    }
    out
}

/// The changed ranges of the old and the new line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WordChanges {
    pub old: Vec<Range>,
    pub new: Vec<Range>,
}

/// Character ranges that differ between two lines; none when the lines are too long (over 500 UTF-16 units) or too
/// unlike (under 0.4 shared) for a word diff to help. A longest-common-subsequence diff over the tokens, not Myers.
pub fn word_changes(old_text: &str, new_text: &str) -> WordChanges {
    if old_text == new_text || utf16_len(old_text) > MAX_WORD_DIFF_CHARS || utf16_len(new_text) > MAX_WORD_DIFF_CHARS {
        return WordChanges::default();
    }
    let a = tokenize(old_text);
    let b = tokenize(new_text);
    let (n, m) = (a.len(), b.len());
    // lcs[i][j] = longest common token run of a[i..] and b[j..]; empty suffixes score zero.
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut old_ranges = Vec::new();
    let mut new_ranges = Vec::new();
    let (mut i, mut j) = (0, 0);
    let (mut oi, mut oj) = (0usize, 0usize);
    let mut common = 0usize;
    while i < n || j < m {
        let old_token = a.get(i);
        let new_token = b.get(j);
        if let (Some(o), Some(nw)) = (old_token, new_token)
            && o == nw
        {
            let len = utf16_len(o);
            common += len;
            oi += len;
            oj += len;
            i += 1;
            j += 1;
        } else if let Some(nw) = new_token
            && (old_token.is_none() || lcs[i][j + 1] >= lcs[i + 1][j])
        {
            let len = utf16_len(nw);
            new_ranges.push((oj, oj + len));
            oj += len;
            j += 1;
        } else if let Some(o) = old_token {
            let len = utf16_len(o);
            old_ranges.push((oi, oi + len));
            oi += len;
            i += 1;
        }
    }
    let total = utf16_len(old_text) + utf16_len(new_text);
    if total == 0 || (2 * common) as f64 / (total as f64) < MIN_SIMILARITY {
        return WordChanges::default();
    }
    WordChanges { old: merge(old_ranges), new: merge(new_ranges) }
}

/// Converts a UTF-16 range from [`word_changes`] to byte offsets into `text`. An end past the text is clamped; an
/// offset that falls inside a surrogate pair snaps to the end of that character.
pub fn utf16_range_to_bytes(text: &str, range: Range) -> (usize, usize) {
    let mut units = 0usize;
    let mut start = None;
    let mut end = None;
    for (byte, c) in text.char_indices() {
        if start.is_none() && units >= range.0 {
            start = Some(byte);
        }
        if end.is_none() && units >= range.1 {
            end = Some(byte);
            break;
        }
        units += c.len_utf16();
    }
    let len = text.len();
    (start.unwrap_or(len), end.unwrap_or(len))
}

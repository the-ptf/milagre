//! The diff engine: turns a file's unified patch into rows a view can draw, plus the list-level helpers around it.
//! Pure logic, no UI and no I/O. Ports of `packages/shared/src/{diff-parse,diff-layout,diff-tree,git-diff,git-codes}`,
//! which the React app and the phone share, so the same patch gives the same rows here.
//!
//! - [`parse`]: `parsePatch`, one file's patch to numbered hunks (the unified row model is `DiffHunk::lines`).
//! - [`layout`]: `splitRows` and `wordChanges` (word marks inside a changed line pair, UTF-16 offsets).
//! - [`tree`]: `buildDiffTree`, the folder tree of the changed files with summed counts.
//! - [`git`]: the diff and history types and their labels (`git-diff.ts`).
//! - [`codes`]: the Git error codes and their messages (`git-codes.mjs`).
//! - [`collate`]: an approximation of JavaScript's `localeCompare` for names, used by [`tree`].
//!
//! The TS has no function that folds unchanged context: the host's `git diff` already cuts a patch into hunks with
//! their context, and the views show every hunk line. Nothing here folds either.

pub mod codes;
pub mod collate;
pub mod git;
pub mod layout;
pub mod parse;
pub mod tree;

pub use layout::{Range, SplitRow, split_rows, word_changes};
pub use parse::{DiffHunk, DiffLine, LineKind, parse_patch};
pub use tree::{DiffTreeNode, build_diff_tree};

#[cfg(test)]
mod tests;

/// JavaScript's `\s` and `String.prototype.trim` whitespace (not the same set as `char::is_whitespace`).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `string.length` in JavaScript: the number of UTF-16 code units.
pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

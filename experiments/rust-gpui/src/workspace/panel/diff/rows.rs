//! The row model: every file of the diff flattened into the rows the virtual list draws, one list item each.
//!
//! The desktop draws each file as a card (`DiffFile.tsx`) inside one scroller, with the browser laying out every
//! row. Here a file is a run of rows: its header, then its body (a message, or each hunk's header and lines, with the
//! comment and thread slots that sit under a line), then the card's bottom edge. Each row draws its own slice of the
//! card (side borders, the header's top corners, the end's bottom ones), so the list only lays out what is on screen.

use std::collections::HashSet;
use std::ops::Range;

use crate::logic::diff::{DiffHunk, split_rows};

/// Unified or split, as the toolbar picks it (remembered for the session, the desktop across launches).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DiffLayout {
    #[default]
    Unified,
    Split,
}

/// One list item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
    /// Comments whose file left the diff, gathered at the top so they can still be deleted.
    Orphans,
    Header {
        file: usize,
    },
    /// Binary, large, loading, error, too large, renamed or no content changes.
    Message {
        file: usize,
    },
    Hunk {
        file: usize,
        hunk: usize,
    },
    /// A unified row: line `line` of hunk `hunk`.
    Line {
        file: usize,
        hunk: usize,
        line: usize,
    },
    /// A split row: the old line on the left, the new on the right (hunk line indexes).
    Split {
        file: usize,
        hunk: usize,
        left: Option<usize>,
        right: Option<usize>,
    },
    /// A PR's review threads on a line, under it.
    Threads {
        file: usize,
        hunk: usize,
        line: usize,
    },
    /// The comments under a line, and the editor when the draft's range ends there.
    Slot {
        file: usize,
        hunk: usize,
        line: usize,
    },
    /// Outdated comments of the file, below its hunks.
    Stale {
        file: usize,
    },
    /// PR threads no row carries, below the hunks.
    Loose {
        file: usize,
    },
    /// The card's bottom edge and the gap to the next file.
    End {
        file: usize,
    },
    /// Room under the last file (for the review bar over a PR's diff).
    Tail,
}

impl Row {
    pub fn file(self) -> Option<usize> {
        match self {
            Row::Orphans | Row::Tail => None,
            Row::Header { file }
            | Row::Message { file }
            | Row::Hunk { file, .. }
            | Row::Line { file, .. }
            | Row::Split { file, .. }
            | Row::Threads { file, .. }
            | Row::Slot { file, .. }
            | Row::Stale { file }
            | Row::Loose { file }
            | Row::End { file } => Some(file),
        }
    }

    /// The hunk line a row shows (a split row: its right side, else its left), for keeping the place across a
    /// layout change.
    pub fn place(self) -> Option<(usize, usize, Option<usize>)> {
        match self {
            Row::Hunk { file, hunk } => Some((file, hunk, None)),
            Row::Line { file, hunk, line } | Row::Threads { file, hunk, line } | Row::Slot { file, hunk, line } => {
                Some((file, hunk, Some(line)))
            }
            Row::Split { file, hunk, left, right } => Some((file, hunk, right.or(left))),
            _ => None,
        }
    }
}

/// What a file's body is.
pub enum Body<'a> {
    /// One of the states a file shows instead of rows.
    Message,
    Hunks(&'a [DiffHunk]),
}

/// What decides a file's rows besides its hunks.
pub struct FileRows<'a> {
    pub file: usize,
    pub collapsed: bool,
    pub layout: DiffLayout,
    pub body: Body<'a>,
    /// (hunk, line) pairs that have a comment slot under them.
    pub slots: &'a HashSet<(usize, usize)>,
    /// (hunk, line) pairs that carry PR threads.
    pub threads: &'a HashSet<(usize, usize)>,
    pub stale: bool,
    pub loose: bool,
}

/// The rows of one file, header to end.
pub fn file_rows(input: &FileRows) -> Vec<Row> {
    let file = input.file;
    let mut rows = vec![Row::Header { file }];
    if !input.collapsed {
        match input.body {
            Body::Message => rows.push(Row::Message { file }),
            Body::Hunks(hunks) => {
                for (h, hunk) in hunks.iter().enumerate() {
                    rows.push(Row::Hunk { file, hunk: h });
                    match input.layout {
                        DiffLayout::Unified => {
                            for line in 0..hunk.lines.len() {
                                rows.push(Row::Line { file, hunk: h, line });
                                after_line(&mut rows, input, h, line);
                            }
                        }
                        DiffLayout::Split => {
                            let index = |target: Option<&crate::logic::diff::DiffLine>| {
                                target.and_then(|t| hunk.lines.iter().position(|l| std::ptr::eq(l, t)))
                            };
                            for pair in split_rows(hunk) {
                                let (left, right) = (index(pair.left), index(pair.right));
                                rows.push(Row::Split { file, hunk: h, left, right });
                                // A context row is the same line in both halves: its threads and slot come once.
                                let lines = [left, right.filter(|r| Some(*r) != left)];
                                for line in lines.into_iter().flatten() {
                                    if input.threads.contains(&(h, line)) {
                                        rows.push(Row::Threads { file, hunk: h, line });
                                    }
                                }
                                for line in lines.into_iter().flatten() {
                                    if input.slots.contains(&(h, line)) {
                                        rows.push(Row::Slot { file, hunk: h, line });
                                    }
                                }
                            }
                        }
                    }
                }
                if input.stale {
                    rows.push(Row::Stale { file });
                }
                if input.loose {
                    rows.push(Row::Loose { file });
                }
            }
        }
    }
    rows.push(Row::End { file });
    rows
}

fn after_line(rows: &mut Vec<Row>, input: &FileRows, hunk: usize, line: usize) {
    if input.threads.contains(&(hunk, line)) {
        rows.push(Row::Threads { file: input.file, hunk, line });
    }
    if input.slots.contains(&(hunk, line)) {
        rows.push(Row::Slot { file: input.file, hunk, line });
    }
}

/// The smallest splice that turns `old` into `new`: the changed middle after the common prefix and suffix, as
/// (range in `old`, range in `new`). `None` when they are equal.
pub fn diff_ranges(old: &[Row], new: &[Row]) -> Option<(Range<usize>, Range<usize>)> {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    if prefix == old.len() && prefix == new.len() {
        return None;
    }
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = old.iter().rev().zip(new.iter().rev()).take(max_suffix).take_while(|(a, b)| a == b).count();
    Some((prefix..old.len() - suffix, prefix..new.len() - suffix))
}

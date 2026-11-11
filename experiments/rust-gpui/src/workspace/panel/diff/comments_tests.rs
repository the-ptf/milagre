//! `lib/diff-comments.test.ts`, vector for vector, plus the store and the draft.

use super::comments::*;
use crate::logic::diff::parse_patch;

const PATCH: &str = "@@ -1,4 +1,4 @@\n a\n-b\n-c\n+B\n+C\n d\n";

fn hunks() -> Vec<crate::logic::diff::DiffHunk> {
    parse_patch(PATCH)
}

fn comment(selection: DiffSelection, body: &str) -> DiffComment {
    DiffComment {
        id: "1".into(),
        path: "src/a.ts".into(),
        side: selection.side,
        start: selection.start,
        end: selection.end,
        snippet: selection.snippet,
        body: body.into(),
        created_at: 0,
        mode: ChangesMode::Uncommitted,
    }
}

fn rows(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_unified_range_keeps_every_row_and_takes_the_new_sides_numbers() {
    let hunk = &hunks()[0];
    assert_eq!(
        selection_from_rows(hunk, 1, 3, None),
        Some(DiffSelection { side: DiffSide::New, start: 2, end: 2, snippet: rows(&["-b", "-c", "+B"]) })
    );
    let selection = selection_from_rows(hunk, 0, 3, None).unwrap();
    assert_eq!((selection.side, selection.start, selection.end, selection.snippet), (DiffSide::New, 1, 2, rows(&[" a", "-b", "-c", "+B"])));
}

#[test]
fn removed_rows_alone_are_labelled_by_the_old_side() {
    let selection = selection_from_rows(&hunks()[0], 2, 1, None).unwrap();
    assert_eq!((selection.side, selection.start, selection.end, selection.snippet), (DiffSide::Old, 2, 3, rows(&["-b", "-c"])));
}

#[test]
fn a_split_range_keeps_only_its_own_column() {
    let hunk = &hunks()[0];
    let selection = selection_from_rows(hunk, 0, 5, Some(DiffSide::New)).unwrap();
    assert_eq!((selection.side, selection.start, selection.end, selection.snippet), (DiffSide::New, 1, 4, rows(&[" a", "+B", "+C", " d"])));
    assert_eq!(selection_from_rows(hunk, 1, 2, Some(DiffSide::New)), None);
}

#[test]
fn a_comment_finds_its_rows_again_and_goes_outdated_when_they_change() {
    let h = hunks();
    let mixed = comment(selection_from_rows(&h[0], 1, 3, None).unwrap(), "note");
    assert_eq!(locate_comment(&mixed, &h), Some(Located { hunk: 0, lines: vec![1, 2, 3] }));
    assert!(!is_outdated(&mixed, &h));
    assert!(is_outdated(&mixed, &parse_patch("@@ -1,4 +1,4 @@\n a\n-b\n-c\n+X\n+C\n d\n")));
    assert!(is_outdated(&mixed, &[]));
    // The same text on other line numbers is a different place.
    let single = comment(selection_from_rows(&h[0], 3, 3, None).unwrap(), "note");
    assert!(is_outdated(&single, &parse_patch("@@ -5,4 +5,4 @@\n a\n-b\n-c\n+B\n+C\n d\n")));
}

#[test]
fn a_split_column_comment_still_matches_with_the_other_columns_rows_between() {
    let h = hunks();
    let column = comment(selection_from_rows(&h[0], 0, 5, Some(DiffSide::New)).unwrap(), "note");
    assert!(!is_outdated(&column, &h));
}

#[test]
fn labels() {
    assert_eq!(label_for(12, 12), "L12");
    assert_eq!(label_for(12, 15), "L12\u{2013}15");
}

#[test]
fn formats_the_message_with_fences_sides_and_the_mode() {
    let h = hunks();
    let first = comment(selection_from_rows(&h[0], 0, 3, None).unwrap(), "Rename this.");
    let second = DiffComment {
        id: "2".into(),
        path: "README.md".into(),
        side: DiffSide::Old,
        start: 3,
        end: 3,
        snippet: rows(&["-Old tagline"]),
        body: "Keep it.".into(),
        created_at: 0,
        mode: ChangesMode::Uncommitted,
    };
    assert_eq!(
        format_comments_message(&[first, second.clone()], MessageScope::Uncommitted, None),
        [
            "Review comments on the diff (uncommitted changes):",
            "",
            "1. src/a.ts, lines 1\u{2013}2 (new):",
            "```typescript",
            " a",
            "-b",
            "-c",
            "+B",
            "```",
            "Rename this.",
            "",
            "2. README.md, line 3 (old):",
            "```markdown",
            "-Old tagline",
            "```",
            "Keep it.",
        ]
        .join("\n")
    );
    assert!(
        format_comments_message(&[second], MessageScope::Committed, Some("main"))
            .starts_with("Review comments on the diff (committed changes against main):")
    );
}

#[test]
fn long_snippets_keep_the_first_40_rows() {
    let long = DiffComment {
        id: "3".into(),
        path: "x.unknown".into(),
        side: DiffSide::New,
        start: 1,
        end: 50,
        snippet: (0..50).map(|i| format!("+l{i}")).collect(),
        body: "b".into(),
        created_at: 0,
        mode: ChangesMode::Uncommitted,
    };
    let message = format_comments_message(&[long], MessageScope::Uncommitted, None);
    let lines: Vec<&str> = message.split('\n').collect();
    assert_eq!(lines[3], "```");
    assert_eq!(lines[4 + 40], "\u{2026} (10 more lines)");
    assert_eq!(lines.iter().filter(|line| line.starts_with("+l")).count(), 40);
}

#[test]
fn a_snippet_holding_a_fence_gets_a_longer_one() {
    let c = DiffComment {
        id: "4".into(),
        path: "a.md".into(),
        side: DiffSide::New,
        start: 1,
        end: 1,
        snippet: rows(&["+````rust"]),
        body: "b".into(),
        created_at: 0,
        mode: ChangesMode::Uncommitted,
    };
    assert!(format_comments_message(&[c], MessageScope::Uncommitted, None).contains("\n`````markdown\n+````rust\n`````\n"));
}

#[test]
fn extension_of_names_the_extension_or_the_whole_name() {
    assert_eq!(extension_of("src/a.ts"), "ts");
    assert_eq!(extension_of("Makefile"), "Makefile");
    assert_eq!(extension_of("dir.d/.env"), ".env");
    assert_eq!(extension_of("a/b.tar.gz"), "gz");
}

#[test]
fn the_store_keeps_comments_per_chat_and_mode() {
    let h = hunks();
    let mut store = CommentStore::default();
    let sel = selection_from_rows(&h[0], 1, 1, None).unwrap();
    let a = store.add("chat-1", ChangesMode::Uncommitted, "src/a.ts", sel.clone(), "one", 1);
    store.add("chat-1", ChangesMode::Committed, "src/a.ts", sel.clone(), "two", 2);
    store.add("chat-2", ChangesMode::Uncommitted, "src/b.ts", sel, "three", 3);
    assert_eq!(store.shown("chat-1", ChangesMode::Uncommitted).len(), 1);
    assert_eq!(store.counts("chat-1").get(&(ChangesMode::Committed, "src/a.ts".into())), Some(&1));
    store.update("chat-1", &a, "edited");
    assert_eq!(store.all("chat-1")[0].body, "edited");
    store.remove("chat-1", &a);
    assert_eq!(store.all("chat-1").len(), 1);
    assert_eq!(store.all("chat-2").len(), 1, "another Chat's comments stay");
}

#[test]
fn a_draft_drags_within_its_hunk_and_column_and_shift_extends_it() {
    let target = |line| Target { path: "a".into(), hunk: 0, line, side: None };
    let draft = start_draft(None, &target(1), false, true);
    assert!(draft.dragging);
    let moved = drag_over(&draft, &target(3)).unwrap();
    assert_eq!((moved.lo(), moved.hi()), (1, 3));
    assert_eq!(drag_over(&moved, &Target { side: Some(DiffSide::New), ..target(4) }), None, "another column");
    assert_eq!(drag_over(&moved, &Target { hunk: 1, ..target(4) }), None, "another hunk");
    let done = Draft { dragging: false, ..moved };
    let extended = start_draft(Some(&done), &target(0), true, true);
    assert_eq!((extended.anchor, extended.head, extended.dragging), (1, 0, false), "Shift grows the range");
    let h = hunks();
    assert_eq!(extended.editor_row(&h[0]), Some(1));
    let split = Draft { side: Some(DiffSide::New), anchor: 0, head: 2, ..extended };
    assert_eq!(split.editor_row(&h[0]), Some(0), "the last row shown in the new column is a context row");
}
